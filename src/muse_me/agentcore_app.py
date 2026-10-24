"""AgentCore Agent 侧入口（形态 C）：被 AWS Bedrock AgentCore 托管的 Agent 本体。

本模块只做两件事（模块纪律）：
1. SDK 入口：BedrockAgentCoreApp + @app.entrypoint，满足平台 HTTP 契约
   （8080 端口、GET /ping 健康、POST /invocations 流式调用）；
2. 组装现有组件：规划用 llm 模型（默认 MockModel，env 口径与 bootstrap
   一致）、执行用 execution.Orchestrator、工具用 tools.ToolRegistry、
   护栏用 harness/guardrails/policy.md。不复制规划/执行逻辑。

与控制面（server/）的契约（正本 server/src/infrastructure/runtime/
agentcore-runtime.ts）：
- 入参 payload：{prompt, scene, chatId, source, resume}，resume 为 null 或
  {runId, approvedStep}（approvedStep 为顶层步序，number）。
- 出参为 SSE 帧 `data: {"type": ..., "payload": {...}}`：SDK 把本入口逐个
  yield 的 dict 序列化为该形状；type/payload 与本地运行时事件同形
  （plan_created / step_started / tool_called / approval_required /
  step_done / run_done / run_failed）。
- 会话：runtimeSessionId 由控制面按聊天会话生成（≥33 字符、同一会话恒定），
  平台经请求头 X-Amzn-Bedrock-AgentCore-Runtime-Session-Id 注入，
  SDK 以 context.session_id 提供；同一 session 落同一 microVM——挂起态
  以 session_id 为键存进程内字典（见下）。

挂起态生命周期：
- 执行到 approval_required 时，把 {plan, scene, prompt, 挂起步路径,
  已花费, 事实板快照} 存入进程内字典并结束本次生成器（控制面据
  approval_required 把其 Run 置 awaiting_approval）。
- 带 resume 的调用按 session_id 取回挂起态，校验 approvedStep 与挂起步的
  顶层步序一致后以 Orchestrator 的 resume 语义续跑（已完成步不重跑、
  不重复计费）；再次挂起则更新挂起态，跑到终态则删除。
- microVM 文件系统临时、进程可被回收——挂起态只在内存中，丢了就是丢了：
  找不到时如实 yield run_failed（error 写明「挂起态不存在（会话已回收或
  进程重启），请重新发起」），不伪装续跑。运行轨迹正本在控制面
  （控制面落 Run/RunEvent），Agent 侧不落任何持久化。

规划场景归一（与控制面本地运行时同口径）：控制面的本地运行时计划器
（server simulated.buildPlan）对「买入意图」在任意 scene 下都产脚本构建
六步计划（scan→quote→审批 sim_swap）；Python MockModel 只在
scene="script_build" 时产该计划、scene="chat" 只产查价一步。为保证
AgentCore 与本地运行时同题同行为（验收第 10 条的口径），入口在
scene != "script_build" 且 prompt 带买入意图（买 / meme / buy）时，
按 script_build 场景向现有模型取计划——计划本身仍由模型产出，
入口不自造步骤。

未装 SDK 时 import 本模块即抛带安装指引的 ImportError；主包其余导入
路径不依赖本模块、不受影响。启动：

    pip install -r requirements-agentcore.txt   # 或 pip install 'muse-me[agentcore]'
    PYTHONPATH=src python3 -m muse_me.agentcore_app   # 监听 8080
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp
except ImportError as exc:  # pragma: no cover - 无 SDK 环境的清晰报错路径
    raise ImportError(
        "muse_me.agentcore_app 需要官方 SDK bedrock-agentcore（主包本身零依赖，"
        "本模块是可选入口）。安装：pip install -r requirements-agentcore.txt "
        "或 pip install 'muse-me[agentcore]'。"
    ) from exc

from .errors import DemoError
from .execution import Orchestrator, Plan
from .harness_files import HarnessFiles
from .llm import MockModel, OpenRouterModel
from .tools import ToolRegistry, validate_catalog

_SUSPENDED_MISSING = "挂起态不存在（会话已回收或进程重启），请重新发起"


# ---------------- 组件组装（进程内单例，与 bootstrap 同口径） ----------------

@dataclass
class _Components:
    model: Any
    registry: ToolRegistry
    policy: Any


_components: _Components | None = None


def _resolve_harness_root() -> Path:
    """harness 目录定位：env > 部署 zip 布局 > 仓库布局（HarnessFiles 默认）。

    - 仓库布局：src/muse_me/agentcore_app.py → parents[2]/harness；
    - zip 布局（scripts/package_agentcore.sh）：<root>/muse_me/agentcore_app.py
      与 <root>/harness 并列 → parents[1]/harness。
    """
    env_root = os.environ.get("MUSE_ME_HARNESS_ROOT")
    if env_root:
        return Path(env_root)
    here = Path(__file__).resolve()
    for candidate in (here.parents[2] / "harness", here.parents[1] / "harness"):
        if candidate.is_dir():
            return candidate
    return here.parents[2] / "harness"  # 交给 HarnessFiles 按默认口径报错/兜底


def _make_model() -> Any:
    """模型装配，与 bootstrap._make_model 同口径：未知值/openrouter 缺 key
    一律抛错，不静默降级（静默降级会让人以为在跑真模型）。"""
    choice = str(os.environ.get("MUSE_ME_MODEL", "mock"))
    if choice == "mock":
        return MockModel()
    if choice == "openrouter":
        if not os.environ.get("OPENROUTER_API_KEY"):
            raise DemoError(
                "MUSE_ME_MODEL=openrouter 但未配置 OPENROUTER_API_KEY，"
                "拒绝静默降级为 mock")
        return OpenRouterModel()
    raise DemoError(f"未知 MUSE_ME_MODEL：{choice}（只支持 mock / openrouter）")


def _get_components() -> _Components:
    global _components
    if _components is None:
        harness = HarnessFiles(_resolve_harness_root())
        policy = harness.load_guardrails()
        # 与 bootstrap 一致的启动校验：catalog 正本与注册表不一致拒绝启动。
        if not validate_catalog(harness.catalog_text()):
            raise DemoError(
                "harness/tools/catalog.md 与工具注册表不一致（名称/风险级），"
                "拒绝启动")
        _components = _Components(
            model=_make_model(), registry=ToolRegistry(), policy=policy)
    return _components


# ---------------- 挂起态（进程内，以 session_id 为键） ----------------

@dataclass
class _SuspendedRun:
    plan: Plan
    scene: str
    prompt: str
    run_id: str
    step_path: str  # approval_required 的步路径，如 "2"（顶层步序在 "." 前）
    spent_usd: float = 0.0
    facts: dict[str, Any] = field(default_factory=dict)


_suspended: dict[str, _SuspendedRun] = {}


def _top_index(step_path: str) -> int | None:
    head = str(step_path).split(".", 1)[0]
    return int(head) if head.isdigit() else None


def _plan_for(model: Any, scene: str, prompt: str) -> Plan:
    """向现有模型取计划；买入意图做场景归一（见模块 docstring 的口径说明）。"""
    effective = scene
    if scene != "script_build":
        lowered = prompt.lower()
        if "买" in prompt or "meme" in lowered or "buy" in lowered:
            effective = "script_build"
    return model.plan(effective, prompt)


def _drive(
    components: _Components,
    *,
    plan: Plan,
    run_id: str,
    facts: dict[str, Any],
    spent_usd: float,
    resume_from: Any = None,
) -> tuple[list[dict[str, Any]], str | None, float, dict[str, Any]]:
    """驱动 Orchestrator 跑一程，收集 (事件帧, 挂起步路径|None, 已花费, 事实快照)。

    挂起步路径非 None 表示本程停在 approval_required；事件帧已是控制面契约
    形状 {"type", "payload"}。
    """
    orchestrator = Orchestrator(
        tool_call=components.registry.call, policy=components.policy)
    frames: list[dict[str, Any]] = []
    suspended_step: str | None = None
    spent = float(spent_usd)
    for event in orchestrator.run_plan(
        plan,
        {"run_id": run_id, "facts": facts, "spent_usd": spent},
        resume_from=resume_from,
    ):
        frames.append({"type": event.type, "payload": dict(event.payload or {})})
        if event.type == "step_done":
            spent += float((event.payload or {}).get("cost_usd") or 0.0)
        if event.type == "approval_required":
            suspended_step = str((event.payload or {}).get("step") or "")
    return frames, suspended_step, spent, orchestrator.board.snapshot()


def _run_fresh(
    components: _Components, session_id: str, payload: dict[str, Any]
) -> list[dict[str, Any]]:
    prompt = str(payload.get("prompt") or "")
    scene = str(payload.get("scene") or "chat")
    plan = _plan_for(components.model, scene, prompt)
    run_id = uuid.uuid4().hex
    frames, suspended_step, spent, facts = _drive(
        components, plan=plan, run_id=run_id, facts={}, spent_usd=0.0)
    if suspended_step is not None:
        _suspended[session_id] = _SuspendedRun(
            plan=plan, scene=scene, prompt=prompt, run_id=run_id,
            step_path=suspended_step, spent_usd=spent, facts=facts)
    else:
        _suspended.pop(session_id, None)
    return frames


def _run_resume(
    components: _Components, session_id: str, resume: dict[str, Any]
) -> list[dict[str, Any]]:
    state = _suspended.get(session_id)
    if state is None:
        return [{"type": "run_failed",
                 "payload": {"error": _SUSPENDED_MISSING,
                             "reason": "suspended_state_missing"}}]
    expected = _top_index(state.step_path)
    approved_raw = resume.get("approvedStep")
    approved: int | None = None
    if isinstance(approved_raw, bool):
        approved = None
    elif isinstance(approved_raw, (int, float)):
        approved = int(approved_raw)
    elif isinstance(approved_raw, str) and approved_raw.isdigit():
        approved = int(approved_raw)
    if approved is not None and expected is not None and approved != expected:
        return [{"type": "run_failed",
                 "payload": {
                     "error": (f"approvedStep 与挂起步不一致：挂起步为 "
                               f"{state.step_path}（顶层步序 {expected}），"
                               f"收到 {approved}，无法续跑"),
                     "reason": "approved_step_mismatch"}}]
    frames, suspended_step, spent, facts = _drive(
        components, plan=state.plan, run_id=state.run_id, facts=state.facts,
        spent_usd=state.spent_usd,
        resume_from={"approved": [state.step_path]})
    if suspended_step is not None:
        state.step_path = suspended_step
        state.spent_usd = spent
        state.facts = facts
    else:
        _suspended.pop(session_id, None)
    return frames


# ---------------- SDK 入口 ----------------

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke_agent(payload: dict[str, Any], context: Any) -> AsyncIterator[dict[str, Any]]:
    """AgentCore 调用入口：payload 见模块 docstring；逐 yield 输出事件帧，
    SDK 将其序列化为 SSE `data: {...}` 帧（与控制面解析口径一致）。"""
    if not isinstance(payload, dict):
        yield {"type": "run_failed",
               "payload": {"error": f"payload 必须是 JSON 对象，收到 {type(payload).__name__}",
                           "reason": "bad_payload"}}
        return
    session_id = str(getattr(context, "session_id", None) or "no-session")
    try:
        components = _get_components()
        resume = payload.get("resume")
        if isinstance(resume, dict):
            frames = _run_resume(components, session_id, resume)
        else:
            frames = _run_fresh(components, session_id, payload)
    except Exception as exc:  # 规划/组装失败如实落 run_failed，不伪装成功
        yield {"type": "run_failed",
               "payload": {"error": str(exc), "reason": "agent_error"}}
        return
    for frame in frames:
        yield frame


if __name__ == "__main__":
    app.run()  # 默认 8080 端口（平台契约），GET /ping + POST /invocations
