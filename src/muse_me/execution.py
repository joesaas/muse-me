"""执行层（复用 ShadowClaw 口径）：五原语 + Planner 产物 Plan + Orchestrator。

- 状态：隔离副本 + 受控事实板 FactBoard（单写者）；原语间不共享可变状态，
  步骤结果经 save_as 写入事实板，后续步骤从事实板读。
- 每步落 RunEvent：plan_created / step_started / tool_called / approval_required /
  step_done / step_failed / reflect_failed / run_done / run_failed。
- 预算硬顶：累计 cost（工具结果的 cost_usd 或 Step.cost_usd）超
  GuardrailPolicy.max_cost_per_run_usd 时立即停 Run，落 run_failed(reason=budget)。
- 审批挂起：Step.needs_approval 且未获批时产 approval_required 并停止迭代；
  外部审批通过后以 run_plan(plan, ctx, resume_from=...) 续跑——resume_from 支持：
    * int：从该顶层步序开始跑（此前步视为已完成且已批准）；
    * dict：{"start_index": int, "approved": [步路径,...]}；
    * set/list：已批准的步路径集合（如 "2"、"1.0"）。
  步路径 = 以 "." 连接的层级序号，顶层即步序本身。
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
    ):
        self._tool_call = tool_call
        self._policy = policy or GuardrailPolicy()
        self._board = board or FactBoard()

    @property
    def board(self) -> FactBoard:
        return self._board

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
    def _parse_resume(resume_from: Any) -> tuple[int, set[str]]:
        if resume_from is None:
            return 0, set()
        if isinstance(resume_from, int):
            # 从该步续跑 == 该步（含此前各步）的审批已通过
            return resume_from, {str(i) for i in range(resume_from + 1)}
        if isinstance(resume_from, dict):
            start = int(resume_from.get("start_index", 0))
            approved = {str(p) for p in resume_from.get("approved", [])}
            if "start_index" in resume_from:
                approved |= {str(i) for i in range(start + 1)}
            return start, approved
        if isinstance(resume_from, (set, list, tuple)):
            return 0, {str(p) for p in resume_from}
        raise DemoError(f"非法 resume_from：{type(resume_from)}")

    # ---------------- 成本记账 ----------------
    def _charge(self, state: dict[str, Any], amount: float) -> None:
        state["spent"] += amount
        if state["spent"] > self._policy.max_cost_per_run_usd:
            raise _BudgetExceeded()

    # ---------------- 原语分发 ----------------
    def _exec_step(self, step, path, board, emit, state, approved, depth):
        if step.needs_approval and path not in approved:
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
        value = board.read(step.condition)
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
        events, failures = self._run_parallel(step, path, board, state, approved, depth)
        for event in events:
            yield event
        if state["spent"] > self._policy.max_cost_per_run_usd:
            raise _BudgetExceeded()
        yield emit("step_done", {"step": path, "kind": "parallel",
                                 "failures": failures})

    def _run_parallel(self, step, path, board, state, approved, depth):
        """asyncio 并发执行各分支；单分支失败隔离，不拖垮其余分支。"""
        results: dict[int, tuple[list[RunEvent], str | None, dict[str, Any]]] = {}

        async def run_branch(i: int, child: Step):
            child_events: list[RunEvent] = []
            sub_board = FactBoard(initial=board.snapshot())

            def collect_emit(type_: str, payload: dict[str, Any] | None = None):
                event = RunEvent(run_id="", type=type_, payload=payload or {})
                child_events.append(event)
                return event

            error: str | None = None
            try:
                for event in self._exec_step(
                    child, f"{path}.{i}", sub_board, collect_emit, state, approved, depth
                ):
                    if event not in child_events:
                        child_events.append(event)
            except (_StepFailed, _Suspended, _BudgetExceeded) as exc:
                error = str(exc) or exc.__class__.__name__
            return i, child_events, error, sub_board.snapshot()

        async def gather_all():
            return await asyncio.gather(
                *(run_branch(i, c) for i, c in enumerate(step.children)),
                return_exceptions=False,
            )

        gathered = asyncio.run(gather_all())
        merged: list[RunEvent] = []
        failures = 0
        spent_extra = 0.0
        for i, child_events, error, snap in gathered:
            merged.extend(child_events)
            child = step.children[i]
            if error:
                failures += 1
                merged.append(RunEvent(run_id="", type="step_failed",
                                       payload={"step": f"{path}.{i}",
                                                "error": error, "isolated": True}))
            elif child.save_as and child.save_as in snap:
                board.write(child.save_as, snap[child.save_as])
        return merged, failures

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
    def _resolve_args(args: dict[str, Any], board: FactBoard) -> dict[str, Any]:
        """只做 ${key} / ${key.field} 两类插值（与脚本 DSL 沙箱口径一致）。"""
        out: dict[str, Any] = {}
        for key, value in args.items():
            if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
                expr = value[2:-1]
                head, _, rest = expr.partition(".")
                resolved = board.read(head)
                if isinstance(resolved, dict) and rest:
                    resolved = resolved.get(rest)
                out[key] = resolved
            else:
                out[key] = value
        return out
