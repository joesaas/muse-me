"""运行时适配（RuntimePort 五法）：LocalRuntime 第一实现；AgentCoreRuntime 桩。

为避免循环导入，LocalRuntime 的依赖全部经构造注入：
- model：ModelPort（产 Plan）；缺省时用单步回显计划。
- tool_call：原子工具调用函数 (name, args) -> dict；缺省时惰性取 tools 默认注册表。
- store：可选 StorePort；给定时 invoke 全程落 Run/RunEvent 并维护 Run 状态机。
- policy：GuardrailPolicy，传给 Orchestrator 做预算硬顶。
- event_sink：可选回调，每产一个 RunEvent 同步通知（SSE 层可用）。
"""
from __future__ import annotations

import os
from typing import Any, Callable, Iterator

from .domain import Run, RunEvent, RunStatus, Session
from .errors import RuntimeNotConfigured
from .execution import Orchestrator, Plan, tool_step


def _default_tool_call():
    from .tools import ToolRegistry

    registry = ToolRegistry()
    return registry.call


class LocalRuntime:
    """进程内运行时：调用 Orchestrator 执行 Plan，事件可落库、可回放。"""

    def __init__(
        self,
        model: Any = None,
        tool_call: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
        store: Any = None,
        policy: Any = None,
        event_sink: Callable[[RunEvent], None] | None = None,
        user_id: str = "demo-user",
    ):
        self._model = model
        self._tool_call = tool_call
        self._store = store
        self._policy = policy
        self._event_sink = event_sink
        self._user_id = user_id
        self._sessions: dict[str, Session] = {}
        self._traces: dict[str, list[RunEvent]] = {}
        self._active: set[str] = set()
        self._cancelled: set[str] = set()

    # ---------------- 五法 ----------------
    def create_session(self, user_id: str, scene: str = "chat") -> Session:
        session = Session(user_id=user_id or self._user_id, scene=scene)
        self._sessions[session.id] = session
        return session

    def invoke(
        self, session_id: str, prompt: str, ctx: dict[str, Any] | None = None
    ) -> Iterator[RunEvent]:
        ctx = dict(ctx or {})
        session = self._sessions.get(session_id)
        scene = ctx.get("scene") or (session.scene if session else "chat")
        user_id = (session.user_id if session else None) or ctx.get("user_id") \
            or self._user_id
        plan = ctx.get("plan") or self._make_plan(scene, prompt)
        run = Run(user_id=user_id, scene=scene, source=ctx.get("source", "chat"),
                  chat_id=ctx.get("chat_id"))
        if self._store is not None:
            self._store.create_run(run)
        self._active.add(run.id)
        orchestrator = Orchestrator(
            tool_call=self._tool_call or _default_tool_call(), policy=self._policy
        )
        run_ctx = {"run_id": run.id, "facts": ctx.get("facts") or {},
                   "spent_usd": ctx.get("spent_usd") or 0.0}
        trace: list[RunEvent] = []
        suspended = False
        failed = False
        try:
            for event in orchestrator.run_plan(
                plan, run_ctx, resume_from=ctx.get("resume_from")
            ):
                event.run_id = run.id
                trace.append(event)
                if self._store is not None:
                    self._store.add_run_event(event)
                    payload = event.payload or {}
                    if "cost_usd" in payload and event.type == "step_done":
                        self._store.add_run_cost(run.id, float(payload["cost_usd"]))
                if event.type == "approval_required":
                    suspended = True
                if event.type == "run_failed":
                    failed = True
                    if self._store is not None:
                        self._store.set_run_error(run.id, str(payload_reason(event)))
                if self._event_sink is not None:
                    self._event_sink(event)
                yield event
                if run.id in self._cancelled:
                    break
        finally:
            self._active.discard(run.id)
            self._traces[run.id] = trace
            if self._store is not None:
                self._finish_run(run, suspended=suspended, failed=failed,
                                 cancelled=run.id in self._cancelled)

    def _finish_run(self, run: Run, suspended: bool, failed: bool, cancelled: bool) -> None:
        current = self._store.get_run(run.id)
        if current is None or current.status in (
            RunStatus.DONE, RunStatus.FAILED, RunStatus.CANCELLED
        ):
            return
        if cancelled:
            target = RunStatus.CANCELLED
        elif suspended:
            target = RunStatus.AWAITING_APPROVAL
        elif failed:
            target = RunStatus.FAILED
        else:
            target = RunStatus.DONE
        try:
            self._store.update_run_status(run.id, target)
        except Exception:
            pass  # 已在合法路径上收口，状态维护失败不掩盖执行结果

    def cancel(self, run_id: str) -> bool:
        if run_id in self._active:
            self._cancelled.add(run_id)
            return True
        if self._store is not None:
            run = self._store.get_run(run_id)
            if run is not None and run.status == RunStatus.RUNNING:
                self._cancelled.add(run_id)
                try:
                    self._store.update_run_status(run_id, RunStatus.CANCELLED)
                    return True
                except Exception:
                    return False
        return False

    def get_trace(self, run_id: str) -> list[RunEvent]:
        if self._store is not None:
            events = self._store.list_run_events(run_id)
            if events:
                return events
        return list(self._traces.get(run_id, []))

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "runtime": "local",
            "sessions": len(self._sessions),
            "active_runs": len(self._active),
            "store": bool(self._store),
        }

    # ---------------- 内部 ----------------
    def _make_plan(self, scene: str, prompt: str) -> Plan:
        if self._model is not None:
            return self._model.plan(scene, prompt)
        return Plan(goal=prompt, scene=scene, steps=[], metadata={"planner": "none"})


def payload_reason(event: RunEvent) -> str:
    payload = event.payload or {}
    return payload.get("reason") or payload.get("error") or ""


class AgentCoreRuntime:
    """AWS Bedrock AgentCore 运行时桩（阶段 5 补真实传输）。

    未配置（region 与 runtime_arn 缺一）时：
    - health() 返回 {"status": "not_configured", ...} 并附配置指引；
    - create_session / invoke 抛 RuntimeNotConfigured 并附指引。
    配置齐全也只到桩：invoke 仍抛 RuntimeNotConfigured，注明传输未实现，
    不伪装成已实测（阶段 5 做同题对比后替换）。
    """

    CONFIG_HINT = (
        "配置 AgentCore 需：1) 环境变量 AWS_REGION（或构造参数 region）；"
        "2) 环境变量 AGENTCORE_RUNTIME_ARN（或构造参数 runtime_arn），即已在 "
        "Bedrock AgentCore 部署的 Runtime ARN；3) 完成阶段 5 的真实传输实现后"
        "方可调用。当前为桩实现，未做真实联调。"
    )

    def __init__(self, region: str | None = None, runtime_arn: str | None = None):
        self.region = region or os.environ.get("AWS_REGION", "")
        self.runtime_arn = runtime_arn or os.environ.get("AGENTCORE_RUNTIME_ARN", "")

    @property
    def configured(self) -> bool:
        return bool(self.region and self.runtime_arn)

    def health(self) -> dict[str, Any]:
        if not self.configured:
            return {
                "status": "not_configured",
                "runtime": "agentcore",
                "region": self.region or None,
                "hint": self.CONFIG_HINT,
            }
        return {
            "status": "configured_stub",
            "runtime": "agentcore",
            "region": self.region,
            "hint": "配置已齐，但真实传输未实现（阶段 5），invoke 仍不可用。",
        }

    def create_session(self, user_id: str, scene: str = "chat") -> Session:
        raise RuntimeNotConfigured("AgentCoreRuntime 未配置/桩实现。" + self.CONFIG_HINT)

    def invoke(
        self, session_id: str, prompt: str, ctx: dict[str, Any] | None = None
    ) -> Iterator[RunEvent]:
        raise RuntimeNotConfigured("AgentCoreRuntime 未配置/桩实现。" + self.CONFIG_HINT)
        yield  # pragma: no cover - 保持生成器签名

    def cancel(self, run_id: str) -> bool:
        return False

    def get_trace(self, run_id: str) -> list[RunEvent]:
        return []
