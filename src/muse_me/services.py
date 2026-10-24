"""应用服务层：对 API 提供粗粒度用例，组合核心层与引擎层。

适配说明（核心层签名与本层所需不符处，均在本层适配，不动核心层）：
1. LocalRuntime.invoke 每次新建 Run，无法在同一 Run 上续跑 —— 聊天审批续跑
   由 ChatService 用 Orchestrator 直接驱动并把事件补落原 Run。
2. Chat 领域对象无 scene 字段 —— scene 由 ChatService 内存登记（建聊时写入），
   重启后按 feed_item/标题启发式恢复，Demo 级别可接受。
3. LocalRuntime 不建 Approval 行 —— ChatService 在 invoke 后按 approval_required
   事件补建，使「待我确认」队列有据可查。
4. 脚本草稿的实体/参数抽取统一走 scripts_engine.build_draft（内部复用
   MockModel 口径），与线上模型解耦，保证离线确定性。
"""
from __future__ import annotations

from typing import Any

from . import scripts_engine
from .domain import (
    Approval,
    Chat,
    MemoryItem,
    MemoryLevel,
    MemoryStatus,
    Message,
    Run,
    RunEvent,
    RunStatus,
    Script,
)
from .errors import GuardrailDenied, NotFound
from .execution import Orchestrator
from .feed import FeedGenerator
from .scheduler import next_fire

DEFAULT_USER = "demo-user"


# ------------------------------------------------------------------ 聊天
class ChatService:
    def __init__(
        self,
        store: Any,
        runtime: Any,
        model: Any,
        registry: Any,
        policy: Any,
        *,
        user_id: str = DEFAULT_USER,
        harness_version: str = "",
    ):
        self._store = store
        self._runtime = runtime
        self._model = model
        self._registry = registry
        self._policy = policy
        self._user_id = user_id
        self._harness_version = harness_version
        self._sessions: dict[str, str] = {}
        self._scenes: dict[str, str] = {}
        self._goals: dict[str, tuple[str, str]] = {}

    # ---------- 会话管理 ----------
    def create_chat(
        self,
        *,
        title: str = "",
        kind: str = "main",
        feed_item_id: str | None = None,
        scene: str | None = None,
    ) -> Chat:
        kind = "side" if kind in ("side", "topic") else "main"
        chat = Chat(user_id=self._user_id, title=title or ("新话题" if kind == "side" else "主聊"),
                    kind=kind, feed_item_id=feed_item_id)
        self._store.create_chat(chat)
        if scene:
            self._scenes[chat.id] = scene
        if feed_item_id:
            item = self._store.get_feed_item(feed_item_id)
            if item is not None:
                entities = ", ".join(
                    f"{k}={v}" for k, v in (item.entities or {}).items())
                self._store.add_message(Message(
                    chat_id=chat.id, role="system",
                    content=f"【精选上下文】{item.title}——{item.summary}"
                            f"（实体：{entities}）"))
        return chat

    def scene_of(self, chat: Chat) -> str:
        if chat.id in self._scenes:
            return self._scenes[chat.id]
        if chat.feed_item_id and "构建" in (chat.title or ""):
            return "script_build"
        return "chat"

    def list_chats(self) -> list[Chat]:
        return self._store.list_chats(self._user_id)

    def get_chat(self, chat_id: str) -> Chat:
        chat = self._store.get_chat(chat_id)
        if chat is None:
            raise NotFound(f"会话不存在：{chat_id}")
        return chat

    def list_messages(self, chat_id: str) -> list[Message]:
        self.get_chat(chat_id)
        return self._store.list_messages(chat_id)

    # ---------- 发送一轮 ----------
    def send(self, chat_id: str, text: str) -> dict[str, Any]:
        chat = self.get_chat(chat_id)
        scene = self.scene_of(chat)
        self._store.add_message(Message(chat_id=chat.id, role="user", content=text))
        session_id = self._sessions.get(chat.id)
        if session_id is None:
            session = self._runtime.create_session(self._user_id, scene)
            session_id = session.id
            self._sessions[chat.id] = session_id
        events = list(self._runtime.invoke(
            session_id, text,
            {"scene": scene, "chat_id": chat.id, "source": "chat",
             "user_id": self._user_id},
        ))
        if not events:
            raise GuardrailDenied("运行时未产出任何事件")
        run_id = events[0].run_id
        self._goals[run_id] = (scene, text)
        # 适配 3：按 approval_required 事件补建 Approval 行
        for event in events:
            if event.type == "approval_required":
                self._create_chat_approval(run_id, scene, text, event)
        reply = self._model.complete(self._history(chat.id))
        self._store.add_message(
            Message(chat_id=chat.id, role="assistant", content=reply))
        self._store.add_run_event(RunEvent(
            run_id=run_id, type="assistant_delta", payload={"text": reply}))
        extra = ""
        if scene == "script_build":
            extra = self._save_script_from_chat(chat, text)
        return {"run_id": run_id, "reply": reply, "extra": extra}

    def _history(self, chat_id: str) -> list[dict[str, str]]:
        role_map = {"user": "user", "assistant": "assistant", "system": "system"}
        return [
            {"role": role_map.get(m.role, "user"), "content": m.content}
            for m in self._store.list_messages(chat_id)
        ]

    def _create_chat_approval(
        self, run_id: str, scene: str, text: str, event: RunEvent
    ) -> Approval:
        payload = event.payload or {}
        step_path = str(payload.get("step") or "0")
        step_index = int(step_path) if step_path.isdigit() else 0
        amount = None
        try:
            plan = self._model.plan(scene, text)
            if 0 <= step_index < len(plan.steps):
                value = plan.steps[step_index].args.get("amount_usd")
                if isinstance(value, (int, float)):
                    amount = float(value)
        except Exception:
            amount = None
        return self._store.create_approval(Approval(
            run_id=run_id, step_index=step_index,
            action=str(payload.get("tool") or payload.get("label") or "敏感操作"),
            risk="write", amount_usd=amount))

    def _upsert_script(self, script: Script) -> Script:
        """同名脚本不新建重复项：更新已有脚本的 doc（仓库层自动递增版本）。"""
        for existing in self._store.list_scripts(self._user_id):
            if existing.name == script.name:
                existing.doc = script.doc
                existing.description = script.description
                existing.origin_chat_id = script.origin_chat_id
                existing.origin_feed_item_id = script.origin_feed_item_id
                return self._store.update_script(existing)
        return self._store.create_script(script)

    def _save_script_from_chat(self, chat: Chat, text: str) -> str:
        item = None
        if chat.feed_item_id:
            item = self._store.get_feed_item(chat.feed_item_id)
        draft = scripts_engine.build_draft(text, feed_item=item)
        script = Script(user_id=self._user_id, name=str(draft["name"]), doc=draft,
                        description=str(draft.get("description") or ""),
                        origin_chat_id=chat.id,
                        origin_feed_item_id=chat.feed_item_id)
        script = self._upsert_script(script)
        note = (f"已把这次做法存成脚本《{script.name}》，"
                "在「我的脚本」里可以试运行、改参数重跑，或设为定时任务。")
        self._store.add_message(
            Message(chat_id=chat.id, role="assistant", content=note))
        return note

    # ---------- 审批续跑（聊天来源） ----------
    def resume_chat_run(self, run: Run, approval: Approval) -> None:
        """适配 1：用 Orchestrator 在原 Run 上续跑已批准的计划。"""
        scene, goal = self._goals.get(run.id, (run.scene, ""))
        if not goal and run.chat_id:
            users = [m for m in self._store.list_messages(run.chat_id)
                     if m.role == "user"]
            goal = users[-1].content if users else ""
        plan = self._model.plan(scene, goal)
        if run.status == RunStatus.AWAITING_APPROVAL:
            self._store.update_run_status(run.id, RunStatus.RUNNING)
        orchestrator = Orchestrator(tool_call=self._registry.call, policy=self._policy)
        suspended = failed = False
        for event in orchestrator.run_plan(
            plan, {"run_id": run.id},
            resume_from={"approved": [str(approval.step_index)]},
        ):
            event.run_id = run.id
            event.seq = 0  # 交给 store 自动续号，避免与首跑 seq 冲突
            self._store.add_run_event(event)
            if event.type == "step_done" and "cost_usd" in (event.payload or {}):
                self._store.add_run_cost(run.id, float(event.payload["cost_usd"]))
            if event.type == "approval_required":
                suspended = True
                self._create_chat_approval(run.id, scene, goal, event)
            if event.type == "run_failed":
                failed = True
                self._store.set_run_error(
                    run.id, str((event.payload or {}).get("error") or "step_failed"))
        current = self._store.get_run(run.id)
        if current is not None and current.status == RunStatus.RUNNING:
            target = (RunStatus.AWAITING_APPROVAL if suspended
                      else RunStatus.FAILED if failed else RunStatus.DONE)
            self._store.update_run_status(run.id, target)
        if run.chat_id:
            text = ("已按你的批准继续执行完毕。" if not (suspended or failed)
                    else "执行又停下了，请看「待我确认」或执行记录。")
            self._store.add_message(
                Message(chat_id=run.chat_id, role="assistant", content=text))

    def cancel(self, run_id: str) -> bool:
        return bool(self._runtime.cancel(run_id))


# ------------------------------------------------------------------ 审批
class ApprovalService:
    def __init__(
        self,
        store: Any,
        registry: Any,
        policy: Any,
        chat_service: ChatService,
        *,
        user_id: str = DEFAULT_USER,
        harness_version: str = "",
    ):
        self._store = store
        self._registry = registry
        self._policy = policy
        self._chat = chat_service
        self._user_id = user_id
        self._harness_version = harness_version

    def list(self, status: str | None = None) -> list[Approval]:
        return self._store.list_approvals(self._user_id, status=status)

    def decide(
        self, approval_id: str, approved: bool, reason: str = ""
    ) -> Approval:
        approval = self._store.get_approval(approval_id)
        if approval is None:
            raise NotFound(f"审批不存在：{approval_id}")
        decided = self._store.decide_approval(
            approval_id, "approved" if approved else "denied", reason)
        run = self._store.get_run(approval.run_id)
        if run is None:
            return decided
        if not approved:
            if run.status == RunStatus.AWAITING_APPROVAL:
                self._store.add_run_event(RunEvent(
                    run_id=run.id, type="run_failed",
                    payload={"reason": "denied", "error": reason or "用户拒绝"}))
                self._store.set_run_error(run.id, reason or "denied")
                self._store.update_run_status(run.id, RunStatus.FAILED)
            if run.chat_id:
                self._store.add_message(Message(
                    chat_id=run.chat_id, role="assistant",
                    content=f"已拒绝该操作{('：' + reason) if reason else ''}，任务已停止。"))
            return decided
        # 批准：按来源续跑
        if run.script_id:
            scripts_engine.resume_script(
                self._store, self._registry, self._policy, run_id=run.id,
                harness_version=self._harness_version)
        elif run.source == "chat" or run.chat_id:
            self._chat.resume_chat_run(run, decided)
        return decided


# ------------------------------------------------------------------ 脚本
class ScriptService:
    def __init__(
        self,
        store: Any,
        registry: Any,
        policy: Any,
        *,
        user_id: str = DEFAULT_USER,
        harness_version: str = "",
    ):
        self._store = store
        self._registry = registry
        self._policy = policy
        self._user_id = user_id
        self._harness_version = harness_version

    def list(self) -> list[Script]:
        return self._store.list_scripts(self._user_id)

    def get(self, script_id: str) -> Script:
        script = self._store.get_script(script_id)
        if script is None:
            raise NotFound(f"脚本不存在：{script_id}")
        return script

    def build_draft(
        self, intent: str, feed_item: Any = None
    ) -> dict[str, Any]:
        draft = scripts_engine.build_draft(intent, feed_item=feed_item)
        scripts_engine.validate_script(draft)
        return draft

    def save_draft(
        self,
        doc: dict[str, Any],
        *,
        origin_chat_id: str | None = None,
        origin_feed_item_id: str | None = None,
    ) -> Script:
        scripts_engine.validate_script(doc)
        script = Script(user_id=self._user_id, name=str(doc["name"]), doc=doc,
                        description=str(doc.get("description") or ""),
                        origin_chat_id=origin_chat_id,
                        origin_feed_item_id=origin_feed_item_id)
        # 与聊天构建同一口径：同名更新版本，不产生重复脚本
        for existing in self._store.list_scripts(self._user_id):
            if existing.name == script.name:
                existing.doc = script.doc
                existing.description = script.description
                return self._store.update_script(existing)
        return self._store.create_script(script)

    def run(
        self,
        script_id: str,
        *,
        params: dict[str, Any] | None = None,
        trial: bool = False,
        source: str = "script",
        job_id: str | None = None,
        entity: dict[str, Any] | None = None,
        version: int | None = None,
    ) -> dict[str, Any]:
        script = self.get(script_id)
        doc = None
        if version is not None and version != script.current_version:
            versioned = self._store.get_script_version(script_id, version)
            if versioned is None:
                raise NotFound(f"脚本版本不存在：{script_id} v{version}")
            doc = versioned.doc
        return scripts_engine.run_script(
            self._store, self._registry, self._policy,
            user_id=self._user_id, script=script, params=params, trial=trial,
            source=source, job_id=job_id, entity=entity, doc=doc,
            harness_version=self._harness_version)

    def trial(self, script_id: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.run(script_id, params=params, trial=True, source="script_trial")


# ------------------------------------------------------------------ 定时任务
class JobService:
    def __init__(self, store: Any, *, user_id: str = DEFAULT_USER):
        self._store = store
        self._user_id = user_id

    def list(self) -> list[Any]:
        return self._store.list_jobs(self._user_id)

    def get(self, job_id: str) -> Any:
        job = self._store.get_job(job_id)
        if job is None:
            raise NotFound(f"定时任务不存在：{job_id}")
        return job

    def create(
        self,
        *,
        name: str,
        script_id: str,
        trigger: dict[str, Any],
        params: dict[str, Any] | None = None,
        script_version: int | None = None,
    ) -> Any:
        from .domain import Job

        if self._store.get_script(script_id) is None:
            raise NotFound(f"脚本不存在：{script_id}")
        trigger = dict(trigger or {"type": "time", "every_minutes": 60})
        trigger_type = str(trigger.pop("type", "time"))
        job = Job(user_id=self._user_id, name=name or "定时任务",
                  script_id=script_id, trigger_type=trigger_type,
                  trigger_spec=trigger, params=dict(params or {}),
                  script_version=script_version, enabled=True)
        from datetime import datetime

        job.next_fire_at = next_fire(job, datetime.now().astimezone())
        return self._store.create_job(job)

    def toggle(self, job_id: str) -> Any:
        job = self.get(job_id)
        job.enabled = not job.enabled
        if job.enabled and job.trigger_type == "time":
            from datetime import datetime

            from .scheduler import parse_iso

            due = parse_iso(job.next_fire_at)
            now = datetime.now().astimezone()
            if due is None or due <= now:
                job.next_fire_at = next_fire(job, now)
        return self._store.update_job(job)

    def last_status(self, job_id: str) -> str:
        runs = self._store.list_job_runs(job_id)
        return runs[-1].status if runs else ""


# ------------------------------------------------------------------ 精选
class FeedService:
    """封装 feed.FeedGenerator：refresh 按当前提示词重生成，list 读库。"""

    def __init__(self, store: Any, generator: FeedGenerator, *,
                 user_id: str = DEFAULT_USER):
        self._store = store
        self._generator = generator
        self._user_id = user_id

    def list(self, limit: int = 50) -> list[Any]:
        return self._store.list_feed_items(self._user_id, limit=limit)

    def refresh(self) -> list[Any]:
        prompt = self._store.get_prompt(self._user_id, "feed")
        content = prompt.content if prompt else ""
        version = prompt.version if prompt else None
        return self._generator.generate(self._user_id, content, version)

    def get(self, item_id: str) -> Any:
        item = self._store.get_feed_item(item_id)
        if item is None:
            raise NotFound(f"精选条目不存在：{item_id}")
        return item


# ------------------------------------------------------------------ 记忆
class MemoryService:
    def __init__(self, store: Any, *, user_id: str = DEFAULT_USER):
        self._store = store
        self._user_id = user_id

    def add(
        self, content: str, level: str | None = None, source: str = ""
    ) -> MemoryItem:
        """分级入库：fact 直接 active、inference 入 pending、never 拒收。

        level 未给定时拿不准归 inference（细节设计 §2 口径）。
        """
        level = level or MemoryLevel.INFERENCE.value
        if level == MemoryLevel.NEVER.value:
            raise GuardrailDenied("这条内容被标记为「说过不记」，拒绝入库")
        status = (MemoryStatus.ACTIVE.value if level == MemoryLevel.FACT.value
                  else MemoryStatus.PENDING.value)
        item = MemoryItem(user_id=self._user_id, content=content, level=level,
                          status=status, source=source)
        return self._store.add_memory(item)

    def list(self, status: str | None = None) -> list[MemoryItem]:
        return self._store.list_memories(self._user_id, status=status)

    def active(self) -> list[MemoryItem]:
        return self.list(status=MemoryStatus.ACTIVE.value)

    def decide(self, memory_id: str, approved: bool) -> MemoryItem:
        if self._store.get_memory(memory_id) is None:
            raise NotFound(f"记忆不存在：{memory_id}")
        return self._store.decide_memory(memory_id, approved)

    def delete(self, memory_id: str) -> bool:
        if not self._store.delete_memory(memory_id):
            raise NotFound(f"记忆不存在：{memory_id}")
        return True


# ------------------------------------------------------------------ 设置
class SettingsService:
    """账号与连接：只读清单。只报状态与引用名，永不回明文（架构 §1.7）。"""

    def __init__(
        self,
        store: Any,
        *,
        user_id: str = DEFAULT_USER,
        model: Any = None,
        runtime: Any = None,
        agentcore: Any = None,
    ):
        self._store = store
        self._user_id = user_id
        self._model = model
        self._runtime = runtime
        self._agentcore = agentcore

    def connections(self) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        model_name = getattr(self._model, "name", "mock")
        if model_name == "openrouter":
            rows.append({"name": "模型通道", "status": "OpenRouter（已配置）",
                         "detail": "密钥经环境变量 OPENROUTER_API_KEY 引用，不落库、不回显"})
        else:
            rows.append({"name": "模型通道", "status": "Mock 模拟模型（离线）",
                         "detail": "设置 MUSE_ME_MODEL=openrouter 且提供 key 后切换真实模型"})
        health = self._runtime.health() if self._runtime is not None else {}
        rows.append({"name": "Agent 运行时",
                     "status": f"本地运行时 {health.get('status', 'ok')}",
                     "detail": "进程内 LocalRuntime，轨迹全量落库可回放"})
        if self._agentcore is not None:
            ac = self._agentcore.health()
            rows.append({"name": "AWS AgentCore",
                         "status": str(ac.get("status", "")),
                         "detail": str(ac.get("hint", ""))[:120]})
        refs = self._store.list_secrets_ref(self._user_id)
        if refs:
            names = "、".join(r["name"] for r in refs)
            rows.append({"name": "密钥库", "status": f"已登记 {len(refs)} 个引用",
                         "detail": f"引用名：{names}（只存引用，不存明文）"})
        else:
            rows.append({"name": "密钥库", "status": "暂无登记引用",
                         "detail": "密钥只存引用名，明文永不进对话与日志"})
        return rows
