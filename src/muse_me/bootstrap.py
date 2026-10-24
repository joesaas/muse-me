"""组合根：全系统只在此处组装适配器（架构 §2）。

create_app(config) -> App：
- config 可选键：db_path（默认 env MUSE_ME_DB 或 data/muse_me.db）、
  harness_root、password（默认 env MUSE_ME_PASSWORD 或 "demo"）、
  user_id（默认 "demo-user"）、start_scheduler（默认 True）、
  tick_seconds、web_root、model（"mock"/"openrouter"，默认 env MUSE_ME_MODEL）。
- App.start(host, port) 起 HTTP 线程 + 调度线程；App.serve() 阻塞版；App.stop() 收口。
- App.handler 为绑定本 app 的 BaseHTTPRequestHandler 子类（api.make_handler）。
"""
from __future__ import annotations

import os
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import services as svc
from .api import make_handler
from .feed import FeedGenerator, SeedNews
from .harness_files import HarnessFiles
from .llm import MockModel, OpenRouterModel
from .runtime import AgentCoreRuntime, LocalRuntime
from .scheduler import SchedulerDaemon
from .seed import seed_if_empty
from .services import DEFAULT_USER
from .storage import SqliteStore
from .tools import ToolRegistry

REPO_ROOT = Path(__file__).resolve().parents[2]


class App:
    def __init__(self, **parts: Any):
        self.__dict__.update(parts)
        self.sessions: dict[str, str] = {}
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port: int | None = None

    @property
    def handler(self):  # noqa: ANN202 - handler 类由 api 工厂生成
        return make_handler(self)

    def start(self, host: str = "127.0.0.1", port: int = 8765) -> "App":
        server = ThreadingHTTPServer((host, port), self.handler)
        server.daemon_threads = True
        self._server = server
        self.port = int(server.server_address[1])
        self._thread = threading.Thread(
            target=server.serve_forever, name="muse-me-http", daemon=True)
        self._thread.start()
        if self.scheduler_enabled and self.scheduler is not None:
            self.scheduler.start()
        return self

    def serve(self, host: str = "127.0.0.1", port: int = 8765) -> None:
        self.start(host, port)
        assert self._server is not None
        try:
            self._thread.join()  # type: ignore[union-attr]
        except KeyboardInterrupt:
            self.stop()

    def stop(self) -> None:
        if self.scheduler is not None:
            self.scheduler.stop()
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


def _make_model(config: dict[str, Any]) -> Any:
    choice = str(config.get("model") or os.environ.get("MUSE_ME_MODEL", "mock"))
    if choice == "openrouter" and os.environ.get("OPENROUTER_API_KEY"):
        return OpenRouterModel()
    return MockModel()


def create_app(config: dict[str, Any] | None = None) -> App:
    config = dict(config or {})
    user_id = str(config.get("user_id") or DEFAULT_USER)
    db_path = str(
        config.get("db_path") or os.environ.get("MUSE_ME_DB")
        or (REPO_ROOT / "data" / "muse_me.db")
    )
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    store = SqliteStore(db_path)

    harness = HarnessFiles(config.get("harness_root"))
    policy = harness.load_guardrails()
    harness_version = harness.harness_version()

    def notify_sink(note: dict[str, Any]) -> None:
        from .domain import Notification

        store.add_notification(Notification(
            user_id=user_id, title=str(note.get("title") or "通知"),
            body=str(note.get("body") or ""), kind=str(note.get("kind") or "info")))

    registry = ToolRegistry(notify_sink=notify_sink)
    model = _make_model(config)
    runtime = LocalRuntime(model=model, tool_call=registry.call, store=store,
                           policy=policy, user_id=user_id)
    agentcore = AgentCoreRuntime()

    chats = svc.ChatService(store, runtime, model, registry, policy,
                            user_id=user_id, harness_version=harness_version)
    scripts = svc.ScriptService(store, registry, policy, user_id=user_id,
                                harness_version=harness_version)
    approvals = svc.ApprovalService(store, registry, policy, chats,
                                    user_id=user_id,
                                    harness_version=harness_version)
    jobs = svc.JobService(store, user_id=user_id)
    feed = svc.FeedService(store, FeedGenerator(store, SeedNews()),
                           user_id=user_id)
    memories = svc.MemoryService(store, user_id=user_id)
    settings = svc.SettingsService(store, user_id=user_id, model=model,
                                   runtime=runtime, agentcore=agentcore)
    service_map = {"chats": chats, "approvals": approvals, "scripts": scripts,
                   "jobs": jobs, "feed": feed, "memories": memories,
                   "settings": settings}

    scheduler_enabled = bool(config.get("start_scheduler", True))
    scheduler = SchedulerDaemon(
        store,
        lambda job, params, entity: scripts.run(
            job.script_id, params=params, source="job", job_id=job.id,
            entity=entity, version=job.script_version),
        registry,
        user_id=user_id,
        tick_seconds=float(config.get("tick_seconds", 1.0)),
        retry_backoff=float(config.get("retry_backoff", 2.0)),
    )

    seed_if_empty(store, user_id=user_id)
    if not store.list_feed_items(user_id):
        feed.refresh()

    return App(
        store=store, services=service_map, scheduler=scheduler,
        scheduler_enabled=scheduler_enabled, registry=registry, model=model,
        runtime=runtime, agentcore=agentcore, harness=harness, policy=policy,
        user_id=user_id,
        password=str(config.get("password")
                     or os.environ.get("MUSE_ME_PASSWORD") or "demo"),
        web_root=str(config.get("web_root") or (REPO_ROOT / "web")),
    )
