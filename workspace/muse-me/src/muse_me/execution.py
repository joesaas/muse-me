"""执行层（复用 ShadowClaw 口径）：五原语 + Planner 产物 Plan + Orchestrator。

- 状态：隔离副本 + 受控事实板 FactBoard（单写者）；原语间不共享可变状态，
  步骤结果经 save_as 写入事实板，后续步骤从事实板读。
- 每步落 RunEvent：plan_created / step_started / tool_called / approval_required /
  step_done / step_failed / reflect_failed / run_done / run_failed。
- 预算硬顶：累计 cost（工具结果的 cost_usd 或 Step.cost_usd）超
  GuardrailPolicy.max_cost_per_run_usd 时立即停 Run，落 run_failed(reason=budget)。
- 审批挂起（统一审批门）：不只信 Step.needs_approval——每个 tool 步执行前
  按工具注册表风险级查 GuardrailPolicy.action_for_risk，write/irreversible
  且处置非 auto、且本步未获批时一律产 approval_required 并停止迭代；
  needs_approval 标记对任意原语步仍生效（显式标记优先于风险推断）。
  外部审批通过后以 run_plan(plan, ctx, resume_from=...) 续跑——resume_from 支持：
    * int：从该顶层步序开始跑（此前步视为已完成且已批准）；
    * dict：{"start_index": int, "approved": [步路径,...]}；无 start_index 时
      与 set/list 同语义（见下）；
    * set/list：已批准的步路径集合（如 "2"、"1.0"）。语义：最早的已批准
      顶层步之前各步视为**已完成**，续跑从该步开始、已批准步照常执行——
      已完成步不重跑、不重复计费（与 int 形式对齐）。
  步路径 = 以 "." 连接的层级序号，顶层即步序本身。
- parallel 原语：分支**串行**执行（分支体是同步生成器，逐个跑完）、单分支
  失败隔离；但分支内出现审批挂起时不隔离——整个 parallel 挂起、上抛，
  run 停在 awaiting_approval，后续步不执行。
"""
from __future__ import annotations

import asyncio
import copy
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .domain import GuardrailPolicy, RunEvent
from .errors import DemoError

MAX_DELEGATE_DEPTH = 2


@dataclass
class Step:
    """计划步：kind 决定原语，默认 tool（调用一个原子工具）。"""

    kind: str = "tool"  # tool|sequence|route|parallel|reflect|delegate
    tool: str | None = None
    args: dict[str, Any] = field(default_factory=dict)
    label: str = ""
    save_as: str | None = None
    needs_approval: bool = False
    cost_usd: float = 0.0  # 无工具结果成本时用它记账
    children: list["Step"] = field(default_factory=list)  # sequence/parallel/reflect
    routes: dict[str, "Step"] = field(default_factory=dict)  # route：键=事实值或 default
    condition: str = ""  # route：读事实板哪个键
    checks: list[str] = field(default_factory=list)  # reflect：期望为真的事实键
    max_retries: int = 2  # reflect 打回上限
    subplan: "Plan | None" = None  # delegate：子计划（独立事实板）


@dataclass
class Plan:
    goal: str = ""
    scene: str = "chat"
    steps: list[Step] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


# ---- 便捷构造器 ----
def tool_step(tool: str, args: dict[str, Any] | None = None, **kw: Any) -> Step:
    return Step(kind="tool", tool=tool, args=dict(args or {}), **kw)


def sequence_step(children: list[Step], **kw: Any) -> Step:
    return Step(kind="sequence", children=list(children), **kw)


def route_step(condition: str, routes: dict[str, Step], **kw: Any) -> Step:
    return Step(kind="route", condition=condition, routes=dict(routes), **kw)


def parallel_step(children: list[Step], **kw: Any) -> Step:
    return Step(kind="parallel", children=list(children), **kw)


def reflect_step(child: Step, checks: list[str], max_retries: int = 2, **kw: Any) -> Step:
    return Step(kind="reflect", children=[child], checks=list(checks),
                max_retries=max_retries, **kw)


def delegate_step(subplan: Plan, **kw: Any) -> Step:
    return Step(kind="delegate", subplan=subplan, **kw)


class FactBoard:
    """受控事实板：单写者。

    由 Orchestrator 在一次 run 内持有写权（writer 标识）；其他 writer 写入抛
    DemoError。读返回深拷贝快照，杜绝原语间共享可变状态。
    """

    def __init__(self, owner: str = "orchestrator", initial: dict[str, Any] | None = None):
        self._owner = owner
        self._data: dict[str, Any] = copy.deepcopy(initial or {})
        self._lock = threading.Lock()

    @property
    def owner(self) -> str:
        return self._owner

    def write(self, key: str, value: Any, writer: str | None = None) -> None:
        writer = writer or self._owner
        if writer != self._owner:
            raise DemoError(
                f"事实板单写者违规：owner={self._owner}，尝试写入者={writer}"
            )
        with self._lock:
            self._data[key] = copy.deepcopy(value)

    def read(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return copy.deepcopy(self._data.get(key, default))

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)


ToolCaller = Callable[[str, dict[str, Any]], dict[str, Any]]


class _Suspended(Exception):
    """内部信号：审批挂起，停止本次迭代。"""


class _BudgetExceeded(Exception):
    pass


class _StepFailed(Exception):
    pass


class Orchestrator:
    def __init__(
        self,
        tool_call: ToolCaller,
        policy: GuardrailPolicy | None = None,
        board: FactBoard | None = None,
        tool_risks: Any = None,
        registry: Any = None,
    ):
        """tool_risks / registry：统一审批门的工具风险级来源（可选注入）。

        - tool_risks：dict[str, str]（工具名->风险级）或 callable(name)->str|None；
        - registry：带 get_tool(name)->AtomicTool|None 的注册表（如 ToolRegistry）；
        - 都不给时惰性查 tools.TOOLS 默认注册表（与默认 tool_call 同源）。
        风险级查不到的工具名不做风险门控（其命名空间由调用方自管；真实计划的
        白名单校验在 llm.plan 入境处完成），已知 write/irreversible 必过门。
        """
        self._tool_call = tool_call
        self._policy = policy or GuardrailPolicy()
        self._board = board or FactBoard()
        self._tool_risks = tool_risks
        self._registry = registry

    @property
    def board(self) -> FactBoard:
        return self._board

    def _risk_of(self, tool_name: str | None) -> str | None:
        """查工具风险级；来源优先级：tool_risks > registry > 默认 TOOLS。"""
        if not tool_name:
            return None
        src = self._tool_risks
        if src is not None:
            if callable(src):
                return src(tool_name)
            if isinstance(src, dict):
                return src.get(tool_name)
        if self._registry is not None:
            tool = self._registry.get_tool(tool_name)
            return tool.risk if tool is not None else None
        from .tools import TOOLS

        tool = TOOLS.get(tool_name)
        return tool.risk if tool is not None else None

    def _approval_required(self, step: Step, path: str, approved: set[str]) -> bool:
        """统一审批门：显式标记，或 write/irreversible 工具的风险处置非 auto。"""
        if path in approved:
            return False
        if step.needs_approval:
            return True
        if step.kind == "tool":
            risk = self._risk_of(step.tool)
            if risk in ("write", "irreversible"):
                return self._policy.action_for_risk(risk) != "auto"
        return False

    # ---------------- 入口 ----------------
    def run_plan(
        self,
        plan: Plan,
        ctx: dict[str, Any] | None = None,
        resume_from: Any = None,
    ) -> Iterator[RunEvent]:
        ctx = dict(ctx or {})
        run_id = ctx.get("run_id") or "run-local"
        board = FactBoard(initial=ctx.get("facts") or {})
        self._board = board
        start_index, approved = self._parse_resume(resume_from)
        seq = 0

        def emit(type_: str, payload: dict[str, Any] | None = None) -> RunEvent:
            nonlocal seq
            seq += 1
            return RunEvent(run_id=run_id, type=type_, payload=payload or {}, seq=seq)

        spent = float(ctx.get("spent_usd") or 0.0)
        state = {"spent": spent, "failed": False}

        yield emit("plan_created", {"goal": plan.goal, "scene": plan.scene,
                                     "steps": len(plan.steps)})
        try:
            for index, step in enumerate(plan.steps):
                if index < start_index:
                    continue
                yield from self._exec_step(
                    step, str(index), board, emit, state, approved, depth=0
                )
        except _Suspended:
            return  # 已产 approval_required，等外部 resume
        except _BudgetExceeded:
            yield emit("run_failed", {"reason": "budget",
                                      "spent_usd": round(state["spent"], 6),
                                      "limit_usd": self._policy.max_cost_per_run_usd})
            return
        except _StepFailed as exc:
            yield emit("run_failed", {"reason": "step_failed", "error": str(exc)})
            return
        yield emit("run_done", {"spent_usd": round(state["spent"], 6),
                                "facts": list(board.snapshot().keys())})

    @staticmethod
    def _top_index(path: str) -> int | None:
        head = str(path).split(".", 1)[0]
        return int(head) if head.isdigit() else None

    @classmethod
    def _resume_start(cls, approved: set[str]) -> int:
        """无显式 start_index 时的续跑起点：最早已批准顶层步（其前视为已完成）。"""
        tops = [t for t in (cls._top_index(p) for p in approved) if t is not None]
        return min(tops) if tops else 0

    @classmethod
    def _parse_resume(cls, resume_from: Any) -> tuple[int, set[str]]:
        if resume_from is None:
            return 0, set()
        if isinstance(resume_from, int):
            # 从该步续跑 == 该步（含此前各步）的审批已通过
            return resume_from, {str(i) for i in range(resume_from + 1)}
        if isinstance(resume_from, dict):
            approved = {str(p) for p in resume_from.get("approved", [])}
            if "start_index" in resume_from:
                start = int(resume_from["start_index"])
                approved |= {str(i) for i in range(start + 1)}
                return start, approved
            # 无 start_index：与 set/list 同语义——已批准步之前视为已完成，
            # 不重跑、不重复计费（修评审：旧实现 start=0 会整表重演）。
            return cls._resume_start(approved), approved
        if isinstance(resume_from, (set, list, tuple)):
            approved = {str(p) for p in resume_from}
            return cls._resume_start(approved), approved
        raise DemoError(f"非法 resume_from：{type(resume_from)}")

    # ---------------- 成本记账 ----------------
    def _charge(self, state: dict[str, Any], amount: float) -> None:
        state["spent"] += amount
        if state["spent"] > self._policy.max_cost_per_run_usd:
            raise _BudgetExceeded()

    # ---------------- 原语分发 ----------------
    def _exec_step(self, step, path, board, emit, state, approved, depth):
        if self._approval_required(step, path, approved):
            yield emit("approval_required", {"step": path, "label": step.label,
                                             "tool": step.tool})
            raise _Suspended()
        handler = {
            "tool": self._prim_tool,
            "sequence": self._prim_sequence,
            "route": self._prim_route,
            "parallel": self._prim_parallel,
            "reflect": self._prim_reflect,
            "delegate": self._prim_delegate,
        }.get(step.kind)
        if handler is None:
            yield emit("step_failed", {"step": path, "error": f"未知原语 {step.kind}"})
            raise _StepFailed(f"未知原语 {step.kind}")
        yield from handler(step, path, board, emit, state, approved, depth)

    # ---------------- 五原语 ----------------
    def _prim_tool(self, step, path, board, emit, state, approved, depth):
        yield emit("step_started", {"step": path, "kind": "tool", "tool": step.tool})
        args = self._resolve_args(step.args, board)
        yield emit("tool_called", {"step": path, "tool": step.tool, "args": args})
        try:
            result = self._tool_call(step.tool, args)
        except Exception as exc:  # 工具失败隔离为 step_failed 事件
            yield emit("step_failed", {"step": path, "tool": step.tool,
                                       "error": str(exc)})
            raise _StepFailed(f"{step.tool}: {exc}") from exc
        if not isinstance(result, dict):
            result = {"value": result}
        cost = float(result.get("cost_usd", step.cost_usd) or 0.0)
        self._charge(state, cost)  # 超硬顶抛 _BudgetExceeded，run_plan 收口
        if step.save_as:
            board.write(step.save_as, result)
        yield emit("step_done", {"step": path, "tool": step.tool,
                                 "save_as": step.save_as, "cost_usd": cost})

    def _prim_sequence(self, step, path, board, emit, state, approved, depth):
        yield emit("step_started", {"step": path, "kind": "sequence"})
        yield from self.sequence(step.children, path, board, emit, state, approved, depth)
        yield emit("step_done", {"step": path, "kind": "sequence"})

    def sequence(self, children, path, board, emit, state, approved, depth):
        for i, child in enumerate(children):
            yield from self._exec_step(
                child, f"{path}.{i}", board, emit, state, approved, depth
            )

    def _prim_route(self, step, path, board, emit, state, approved, depth):
        yield emit("step_started", {"step": path, "kind": "route",
                                    "condition": step.condition})
        value = self._read_path(board, step.condition)
        chosen = step.routes.get(str(value)) or step.routes.get("default")
        if chosen is None:
            yield emit("step_failed", {"step": path,
                                       "error": f"route 无匹配分支：{step.condition}={value!r}"})
            raise _StepFailed(f"route 无匹配分支：{value!r}")
        yield emit("step_done", {"step": path, "kind": "route", "chosen": str(value)})
        yield from self._exec_step(chosen, f"{path}.r", board, emit, state, approved, depth)

    def _prim_parallel(self, step, path, board, emit, state, approved, depth):
        yield emit("step_started", {"step": path, "kind": "parallel",
                                    "branches": len(step.children)})
        events, failures, suspended = self._run_parallel(
            step, path, board, state, approved, depth)
        # 分支事件统一走主 emit 通道重新编号：seq 与 run_id 与主序一致，
        # 不再出现 seq=0 的分支事件（修评审）。
        for event in events:
            yield emit(event.type, event.payload)
        if suspended:
            # 审批挂起不隔离：整个 parallel 挂起，run 停在 awaiting_approval，
            # 不产本步 step_done，后续步不执行（fail-closed）。
            raise _Suspended()
        if state["spent"] > self._policy.max_cost_per_run_usd:
            raise _BudgetExceeded()
        yield emit("step_done", {"step": path, "kind": "parallel",
                                 "failures": failures})

    def _run_parallel(self, step, path, board, state, approved, depth):
        """分支**串行**执行、单分支失败隔离（不拖垮其余分支）。

        名为 parallel、借 asyncio.gather 外壳，但分支体是同步生成器、无
        await 点，实际逐个跑完——不要按真并发理解（评审已指出，行为不变，
        注释如实）。审批挂起例外：不隔离，置 suspended 由 _prim_parallel 上抛。
        返回 (事件列表[未编号], 失败分支数, 是否有分支挂起)。
        """
        async def run_branch(i: int, child: Step):
            child_events: list[RunEvent] = []
            sub_board = FactBoard(initial=board.snapshot())

            def collect_emit(type_: str, payload: dict[str, Any] | None = None):
                event = RunEvent(run_id="", type=type_, payload=payload or {})
                child_events.append(event)
                return event

            error: str | None = None
            suspended = False
            try:
                for _ in self._exec_step(
                    child, f"{path}.{i}", sub_board, collect_emit, state, approved, depth
                ):
                    pass  # 事件由 collect_emit 收集，驱动迭代即可
            except _Suspended:
                suspended = True
            except (_StepFailed, _BudgetExceeded) as exc:
                error = str(exc) or exc.__class__.__name__
            return i, child_events, error, suspended, sub_board.snapshot()

        async def gather_all():
            return await asyncio.gather(
                *(run_branch(i, c) for i, c in enumerate(step.children)),
                return_exceptions=False,
            )

        gathered = asyncio.run(gather_all())
        merged: list[RunEvent] = []
        failures = 0
        suspended = False
        for i, child_events, error, branch_suspended, snap in gathered:
            merged.extend(child_events)
            child = step.children[i]
            if branch_suspended:
                suspended = True
            elif error:
                failures += 1
                merged.append(RunEvent(run_id="", type="step_failed",
                                       payload={"step": f"{path}.{i}",
                                                "error": error, "isolated": True}))
            elif child.save_as and child.save_as in snap:
                board.write(child.save_as, snap[child.save_as])
        return merged, failures, suspended

    def _prim_reflect(self, step, path, board, emit, state, approved, depth):
        if not step.children:
            yield emit("step_failed", {"step": path, "error": "reflect 缺少子步"})
            raise _StepFailed("reflect 缺少子步")
        child = step.children[0]
        attempt = 0
        while True:
            attempt += 1
            yield emit("step_started", {"step": path, "kind": "reflect",
                                        "attempt": attempt})
            yield from self._exec_step(child, f"{path}.0", board, emit, state,
                                       approved, depth)
            missing = [k for k in step.checks if not board.read(k)]
            if not missing:
                yield emit("step_done", {"step": path, "kind": "reflect",
                                         "attempt": attempt})
                return
            yield emit("reflect_failed", {"step": path, "missing": missing,
                                          "attempt": attempt})
            if attempt > step.max_retries:
                raise _StepFailed(
                    f"reflect 检查未过（重试 {step.max_retries} 次）：{missing}"
                )

    def _prim_delegate(self, step, path, board, emit, state, approved, depth):
        if depth >= MAX_DELEGATE_DEPTH:
            yield emit("step_failed", {"step": path,
                                       "error": f"delegate 深度超限（>{MAX_DELEGATE_DEPTH}）"})
            raise _StepFailed("delegate 深度超限")
        if step.subplan is None:
            yield emit("step_failed", {"step": path, "error": "delegate 缺少 subplan"})
            raise _StepFailed("delegate 缺少 subplan")
        yield emit("step_started", {"step": path, "kind": "delegate",
                                    "goal": step.subplan.goal})
        child_board = FactBoard(initial=board.snapshot())  # 隔离副本
        for i, sub in enumerate(step.subplan.steps):
            yield from self._exec_step(sub, f"{path}.{i}", child_board, emit, state,
                                       approved, depth + 1)
        if step.save_as:
            board.write(step.save_as, child_board.snapshot())
        yield emit("step_done", {"step": path, "kind": "delegate",
                                 "save_as": step.save_as})

    # ---------------- 参数解析 ----------------
    @staticmethod
    def _read_path(board: FactBoard, expr: str) -> Any:
        """按 key / key.field 点路径读事实板（route 条件与 ${} 插值共用同一口径）。

        首段是事实键，其余段逐级走 dict；中间值非 dict 时返回当前值（与
        _resolve_args 旧行为一致），缺失段返回 None。
        """
        head, _, rest = expr.partition(".")
        resolved = board.read(head)
        while rest:
            if not isinstance(resolved, dict):
                return resolved
            head, _, rest = rest.partition(".")
            resolved = resolved.get(head)
        return resolved

    @classmethod
    def _resolve_args(cls, args: dict[str, Any], board: FactBoard) -> dict[str, Any]:
        """只做 ${key} / ${key.field} 两类插值（与脚本 DSL 沙箱口径一致）。"""
        out: dict[str, Any] = {}
        for key, value in args.items():
            if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
                out[key] = cls._read_path(board, value[2:-1])
            else:
                out[key] = value
        return out
