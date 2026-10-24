"""纯领域对象与枚举：无 I/O、无外部依赖。

Run 状态机不变量（细节设计 §2）：
    running -> awaiting_approval -> running -> done | failed | cancelled
终态（done/failed/cancelled）不可再迁移，非法迁移抛 InvalidTransition。
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .errors import InvalidTransition


def _new_id() -> str:
    return uuid.uuid4().hex


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())


class RunStatus(str, Enum):
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_RUN_STATUSES = frozenset(
    {RunStatus.DONE, RunStatus.FAILED, RunStatus.CANCELLED}
)

# 合法迁移表：key=当前状态，value=可迁往的状态集合
RUN_TRANSITIONS: dict[RunStatus, frozenset[RunStatus]] = {
    RunStatus.RUNNING: frozenset(
        {
            RunStatus.AWAITING_APPROVAL,
            RunStatus.DONE,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
        }
    ),
    RunStatus.AWAITING_APPROVAL: frozenset(
        {RunStatus.RUNNING, RunStatus.FAILED, RunStatus.CANCELLED}
    ),
    RunStatus.DONE: frozenset(),
    RunStatus.FAILED: frozenset(),
    RunStatus.CANCELLED: frozenset(),
}


def _coerce_status(value: "RunStatus | str") -> RunStatus:
    return value if isinstance(value, RunStatus) else RunStatus(value)


def can_transition(current: "RunStatus | str", target: "RunStatus | str") -> bool:
    return _coerce_status(target) in RUN_TRANSITIONS[_coerce_status(current)]


def validate_transition(current: "RunStatus | str", target: "RunStatus | str") -> None:
    """非法迁移抛 InvalidTransition。"""
    cur, tgt = _coerce_status(current), _coerce_status(target)
    if tgt not in RUN_TRANSITIONS[cur]:
        raise InvalidTransition(f"Run 状态非法迁移：{cur.value} -> {tgt.value}")


class ChatKind(str, Enum):
    MAIN = "main"
    TOPIC = "topic"  # 旁聊（界面名「新话题」）


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


class RiskLevel(str, Enum):
    READ = "read"
    WRITE = "write"
    IRREVERSIBLE = "irreversible"


class MemoryLevel(str, Enum):
    FACT = "fact"  # 可自动入
    INFERENCE = "inference"  # 须批准后生效
    NEVER = "never"  # 拒绝入库


class MemoryStatus(str, Enum):
    ACTIVE = "active"
    PENDING = "pending"
    REJECTED = "rejected"


class TriggerType(str, Enum):
    TIME = "time"
    EVENT = "event"
    CONDITION = "condition"


@dataclass
class Chat:
    user_id: str
    title: str = ""
    kind: str = ChatKind.MAIN.value
    feed_item_id: str | None = None
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)


@dataclass
class Message:
    chat_id: str
    role: str
    content: str
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class Session:
    """RuntimePort.create_session 的返回：一次运行时会话。"""

    user_id: str
    scene: str = "chat"
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class Run:
    user_id: str
    scene: str = "chat"
    source: str = "chat"  # chat | script | job | feed
    chat_id: str | None = None
    script_id: str | None = None
    job_id: str | None = None
    status: RunStatus = RunStatus.RUNNING
    cost_usd: float = 0.0
    tokens: int = 0
    harness_version: str = ""
    error: str = ""
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    def transition_to(self, target: "RunStatus | str") -> None:
        validate_transition(self.status, target)
        self.status = _coerce_status(target)
        self.updated_at = _now()


@dataclass
class RunEvent:
    run_id: str
    type: str  # plan_created/step_started/tool_called/approval_required/step_done/reflect_failed/run_done/run_failed...
    payload: dict[str, Any] = field(default_factory=dict)
    seq: int = 0
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class Approval:
    run_id: str
    step_index: int
    action: str
    risk: str = RiskLevel.WRITE.value
    amount_usd: float | None = None
    status: ApprovalStatus = ApprovalStatus.PENDING
    reason: str = ""  # 拒绝理由（回流给 Agent）
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)
    decided_at: str = ""


@dataclass
class MemoryItem:
    user_id: str
    content: str
    level: str = MemoryLevel.INFERENCE.value  # 拿不准归 inference
    status: str = MemoryStatus.PENDING.value
    source: str = ""
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class Script:
    user_id: str
    name: str
    doc: dict[str, Any] = field(default_factory=dict)  # 当前版本脚本 JSON
    description: str = ""
    current_version: int = 1
    origin_chat_id: str | None = None
    origin_feed_item_id: str | None = None
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)


@dataclass
class ScriptVersion:
    script_id: str
    version: int
    doc: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class Job:
    user_id: str
    name: str
    script_id: str
    trigger_type: str = TriggerType.TIME.value
    trigger_spec: dict[str, Any] = field(default_factory=dict)  # 时间/事件/条件规格
    params: dict[str, Any] = field(default_factory=dict)
    script_version: int | None = None  # None=钉当前版本语义由服务层解释
    enabled: bool = True
    next_fire_at: str = ""
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class JobRun:
    job_id: str
    run_id: str | None = None
    script_version: int | None = None  # 实际执行版本（留痕）
    status: str = "running"  # running|done|failed
    attempt: int = 1
    error: str = ""
    id: str = field(default_factory=_new_id)
    started_at: str = field(default_factory=_now)
    finished_at: str = ""


@dataclass
class FeedItem:
    user_id: str
    title: str
    summary: str = ""
    source: str = ""
    url: str = ""
    topic: str = ""
    entities: dict[str, Any] = field(default_factory=dict)  # token/合约/赛道
    published_at: str = ""
    prompt_version: int | None = None
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class Notification:
    user_id: str
    title: str
    body: str = ""
    kind: str = "info"
    read: bool = False
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class PromptDoc:
    user_id: str
    key: str  # 如 "feed"
    content: str = ""
    version: int = 1
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now)


@dataclass
class AtomicTool:
    """原子工具元数据（实现在 tools.py 的注册表，脚本只能调用白名单内工具）。"""

    name: str
    risk: str  # read | write | irreversible
    description: str = ""
    params: dict[str, Any] = field(default_factory=dict)  # 参数 schema（简式）


@dataclass
class GuardrailPolicy:
    """护栏策略：由 harness/guardrails/policy.md 的 policy 代码块解析而来。"""

    max_cost_per_run_usd: float = 1.00
    max_cost_per_day_usd: float = 10.00
    max_sim_amount_usd: float = 1000.0
    approval_timeout_minutes: int = 60
    risk_levels: dict[str, str] = field(
        default_factory=lambda: {
            "read": "auto",
            "write": "batch_approval",
            "irreversible": "single_approval",
        }
    )
    approval_default: str = "deny"

    def action_for_risk(self, risk: str) -> str:
        """风险级 -> 处置：auto | batch_approval | single_approval | deny（未知从严）。"""
        return self.risk_levels.get(risk, "deny")
