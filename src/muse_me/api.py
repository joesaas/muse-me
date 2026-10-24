"""API 层：http.server 实现细节设计 §3 全部路由 + 取消/下载两条补充路由。

契约适配（后端 domain → frontend/src/types.ts，一一对应在此收口）：
- Chat.kind：domain 存 "main"/"side"，原样返回（前端以 side 判「新话题」）；
- Message.role：domain 的 system/tool → 前端 "sys"；
- FeedItem.entities：domain 是 dict → 前端数组 [{label, value, kind}]；
- Approval.title/detail/risk_level：由 domain 的 action/risk 组装；
- Run.title/kind：由 source 与关联实体组装，events 序列化为 {type, ts, tool, summary, text}。
鉴权：POST /api/login 口令（bootstrap 注入，来自 env MUSE_ME_PASSWORD，默认 demo）
换 muse_session cookie，其余 /api/* 无 cookie 一律 401。
文件下载：files.ref 形如 "script:<id>" 时按需生成该脚本的 JSON 导出
（seed 时只登记清单，内容不预生成，下载时现拼——简单且永远最新）。
"""
from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .domain import RunStatus
from .errors import (
    DemoError,
    GuardrailDenied,
    InvalidTransition,
    NotFound,
    PermissionDenied,
    RuntimeNotConfigured,
    ValidationFailed,
)

TERMINAL = {RunStatus.DONE.value, RunStatus.FAILED.value, RunStatus.CANCELLED.value}


# ---------------------------------------------------------------- 序列化
def chat_json(chat: Any) -> dict[str, Any]:
    return {"id": chat.id, "title": chat.title, "kind": chat.kind,
            "feed_item_id": chat.feed_item_id, "updated_at": chat.updated_at}


def message_json(msg: Any) -> dict[str, Any]:
    role = {"system": "sys", "tool": "sys"}.get(msg.role, msg.role)
    return {"id": msg.id, "chat_id": msg.chat_id, "role": role,
            "content": msg.content, "created_at": msg.created_at}


def event_summary(event: Any) -> str:
    p = event.payload or {}
    if event.type == "tool_called":
        return f"{p.get('tool', '')} {json.dumps(p.get('args') or {}, ensure_ascii=False)}"
    if event.type == "step_done":
        return f"{p.get('tool', '')} 完成"
    if event.type == "approval_required":
        return f"等待确认：{p.get('tool', '')}"
    if event.type == "assistant_delta":
        return str(p.get("text", ""))
    if event.type == "run_failed":
        return str(p.get("error") or p.get("reason") or "")
    if event.type == "plan_created":
        return f"计划：{p.get('script_name') or p.get('goal') or ''}"
    return str(p.get("label") or "")


def event_json(event: Any) -> dict[str, Any]:
    p = event.payload or {}
    return {"type": event.type, "ts": event.created_at,
            "tool": p.get("tool"), "summary": event_summary(event),
            "text": p.get("text")}


def feed_json(item: Any) -> dict[str, Any]:
    entities = [
        {"label": str(v), "value": str(v), "kind": str(k)}
        for k, v in (item.entities or {}).items()
    ]
    return {"id": item.id, "title": item.title, "summary": item.summary,
            "entities": entities, "source": item.source,
            "published_at": item.published_at}


def script_json(script: Any) -> dict[str, Any]:
    return {"id": script.id, "name": script.name,
            "description": script.description, "version": script.current_version,
            "params": list((script.doc or {}).get("params") or [])}


def approval_json(ap: Any) -> dict[str, Any]:
    return {"id": ap.id, "title": f"确认执行：{ap.action}",
            "detail": f"运行中的敏感步骤（第 {ap.step_index + 1} 步），"
                      "批准后才继续；拒绝将停止这次任务。",
            "amount_usd": ap.amount_usd, "risk_level": ap.risk,
            "status": ap.status.value}


def memory_json(item: Any) -> dict[str, Any]:
    return {"id": item.id, "content": item.content, "level": item.level,
            "status": item.status}


def file_json(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "kind": row["kind"],
            "created_at": row.get("created_at", "")}


def error_status(exc: Exception) -> int:
    if isinstance(exc, NotFound):
        return 404
    if isinstance(exc, (PermissionDenied, GuardrailDenied)):
        return 403
    if isinstance(exc, ValidationFailed):
        return 400
    if isinstance(exc, InvalidTransition):
        return 409
    if isinstance(exc, RuntimeNotConfigured):
        return 503
    return 400


# ---------------------------------------------------------------- Handler 工厂
def make_handler(app: Any):
    store = app.store
    services = app.services
    user = app.user_id
    web_root = Path(app.web_root).resolve()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # ---------- 基础设施 ----------
        def log_message(self, fmt: str, *args: Any) -> None:  # 静默
            pass

        def _send_json(self, status: int, obj: Any) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_text(self, status: int, text: str, ctype: str,
                       filename: str | None = None) -> None:
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if filename:
                from urllib.parse import quote

                self.send_header(
                    "Content-Disposition",
                    "attachment; filename=\"export.json\"; "
                    f"filename*=UTF-8''{quote(filename)}")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8")) if raw else {}
            except json.JSONDecodeError:
                raise ValidationFailed("请求体不是合法 JSON")
            return data if isinstance(data, dict) else {}

        def _authed(self) -> bool:
            cookie = self.headers.get("Cookie") or ""
            for part in cookie.split(";"):
                name, _, value = part.strip().partition("=")
                if name == "muse_session" and value in app.sessions:
                    return True
            return False

        # ---------- 路由 ----------
        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch("PUT")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def _dispatch(self, method: str) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            try:
                if not path.startswith("/api/"):
                    if method == "GET":
                        return self._static(path)
                    return self._send_json(404, {"error": "not found"})
                if path == "/api/login" and method == "POST":
                    return self._login()
                if not self._authed():
                    return self._send_json(401, {"error": "unauthorized"})
                return self._api(method, path, parse_qs(parsed.query))
            except DemoError as exc:
                return self._send_json(error_status(exc), {"error": str(exc)})
            except Exception as exc:  # API 层收口，不漏堆栈给前端
                return self._send_json(500, {"error": f"internal: {exc}"})

        def _login(self) -> None:
            body = self._body()
            if str(body.get("password") or "") != app.password:
                return self._send_json(401, {"error": "口令不对"})
            import secrets as _secrets

            token = _secrets.token_hex(16)
            app.sessions[token] = user
            payload = json.dumps({"ok": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Set-Cookie",
                             f"muse_session={token}; HttpOnly; Path=/")
            self.end_headers()
            self.wfile.write(payload)

        def _static(self, path: str) -> None:
            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            target = (web_root / rel).resolve()
            if web_root not in target.parents and target != web_root:
                return self._send_json(404, {"error": "not found"})
            if not target.is_file():
                return self._send_json(404, {"error": "not found"})
            ctype = {".html": "text/html; charset=utf-8",
                     ".css": "text/css; charset=utf-8",
                     ".js": "text/javascript; charset=utf-8",
                     ".json": "application/json",
                     ".svg": "image/svg+xml"}.get(target.suffix,
                                                  "application/octet-stream")
            return self._send_text(200, target.read_text(encoding="utf-8"), ctype)

        # ---------- /api/* ----------
        def _api(self, method: str, path: str, query: dict[str, Any]) -> None:
            seg = [s for s in path.split("/") if s][1:]  # 去掉 api 前缀
            chats = services["chats"]
            approvals_svc = services["approvals"]
            scripts_svc = services["scripts"]
            jobs_svc = services["jobs"]
            feed_svc = services["feed"]
            memories_svc = services["memories"]

            # 登录之外的路由表
            if seg == ["chats"]:
                if method == "GET":
                    return self._send_json(200, [chat_json(c) for c in chats.list_chats()])
                if method == "POST":
                    body = self._body()
                    chat = chats.create_chat(
                        title=str(body.get("title") or ""),
                        kind=str(body.get("kind") or "main"),
                        feed_item_id=body.get("feed_item_id"),
                        scene=body.get("scene"))
                    return self._send_json(200, chat_json(chat))
            if len(seg) == 3 and seg[0] == "chats" and seg[2] == "messages":
                if method == "GET":
                    return self._send_json(
                        200, [message_json(m) for m in chats.list_messages(seg[1])])
            if len(seg) == 3 and seg[0] == "chats" and seg[2] == "send":
                if method == "POST":
                    body = self._body()
                    result = chats.send(seg[1], str(body.get("text") or ""))
                    return self._send_json(200, {"run_id": result["run_id"]})
            if seg == ["events"] and method == "GET":
                run_id = (query.get("run_id") or [""])[0]
                return self._events(run_id)
            if seg == ["approvals"]:
                if method == "GET":
                    return self._send_json(
                        200, [approval_json(a) for a in approvals_svc.list()])
            if len(seg) == 3 and seg[0] == "approvals" and seg[2] == "decide":
                if method == "POST":
                    body = self._body()
                    decided = approvals_svc.decide(
                        seg[1], bool(body.get("approved")),
                        str(body.get("reason") or ""))
                    return self._send_json(200, approval_json(decided))
            if seg == ["feed"]:
                if method == "GET":
                    return self._send_json(
                        200, [feed_json(i) for i in feed_svc.list()])
            if seg == ["feed", "refresh"] and method == "POST":
                return self._send_json(
                    200, [feed_json(i) for i in feed_svc.refresh()])
            if seg == ["prompts", "feed"]:
                if method == "GET":
                    doc = store.get_prompt(user, "feed")
                    return self._send_json(200, {
                        "content": doc.content if doc else "",
                        "version": doc.version if doc else 0})
                if method == "PUT":
                    body = self._body()
                    doc = store.set_prompt(user, "feed", str(body.get("content") or ""))
                    feed_svc.refresh()
                    return self._send_json(
                        200, {"content": doc.content, "version": doc.version})
            if seg == ["prompts", "feed", "versions"] and method == "GET":
                versions = store.list_prompt_versions(user, "feed")
                return self._send_json(200, [
                    {"content": v.content, "version": v.version} for v in versions])
            if seg == ["prompts", "feed", "rollback"] and method == "POST":
                body = self._body()
                target_version = int(body.get("version") or 0)
                versions = {v.version: v for v in store.list_prompt_versions(user, "feed")}
                if target_version not in versions:
                    return self._send_json(404, {"error": "版本不存在"})
                doc = store.set_prompt(user, "feed", versions[target_version].content)
                feed_svc.refresh()
                return self._send_json(
                    200, {"content": doc.content, "version": doc.version})
            if seg == ["scripts"]:
                if method == "GET":
                    return self._send_json(
                        200, [script_json(s) for s in scripts_svc.list()])
            if seg == ["scripts", "build"] and method == "POST":
                body = self._body()
                intent = str(body.get("intent") or "")
                item = None
                if body.get("chat_id"):
                    chat = chats.get_chat(str(body["chat_id"]))
                    users = [m for m in store.list_messages(chat.id)
                             if m.role == "user"]
                    intent = intent or (users[-1].content if users else "")
                    if chat.feed_item_id:
                        item = store.get_feed_item(chat.feed_item_id)
                if body.get("feed_item_id"):
                    item = store.get_feed_item(str(body["feed_item_id"]))
                draft = scripts_svc.build_draft(intent, feed_item=item)
                return self._send_json(200, draft)
            if len(seg) == 3 and seg[0] == "scripts" and seg[2] in ("trial", "run"):
                if method == "POST":
                    body = self._body()
                    params = body.get("params") if isinstance(body.get("params"), dict) else {}
                    if seg[2] == "trial":
                        result = scripts_svc.trial(seg[1], params=params)
                    else:
                        result = scripts_svc.run(seg[1], params=params)
                    return self._send_json(200, result)
            if seg == ["jobs"]:
                if method == "GET":
                    return self._send_json(200, [self._job_json(j) for j in jobs_svc.list()])
                if method == "POST":
                    body = self._body()
                    job = jobs_svc.create(
                        name=str(body.get("name") or "定时任务"),
                        script_id=str(body.get("script_id") or ""),
                        trigger=body.get("trigger") or {"type": "time",
                                                        "every_minutes": 60},
                        params=body.get("params") or {})
                    return self._send_json(200, self._job_json(job))
            if len(seg) == 3 and seg[0] == "jobs" and seg[2] == "toggle":
                if method == "POST":
                    job = jobs_svc.toggle(seg[1])
                    return self._send_json(200, self._job_json(job))
            if seg == ["runs"]:
                if method == "GET":
                    return self._send_json(
                        200, [self._run_json(r, with_events=False)
                              for r in store.list_runs(user)])
            if len(seg) == 2 and seg[0] == "runs":
                if method == "GET":
                    run = store.get_run(seg[1])
                    if run is None:
                        raise NotFound(f"运行不存在：{seg[1]}")
                    return self._send_json(200, self._run_json(run, with_events=True))
            if len(seg) == 3 and seg[0] == "runs" and seg[2] == "cancel":
                if method == "POST":
                    ok = chats.cancel(seg[1])
                    if not ok:
                        run = store.get_run(seg[1])
                        if run is not None and run.status == RunStatus.RUNNING:
                            store.update_run_status(seg[1], RunStatus.CANCELLED)
                            ok = True
                    return self._send_json(200, {"ok": ok})
            if seg == ["memories"]:
                if method == "GET":
                    items = [m for m in memories_svc.list()
                             if m.status != "rejected"]
                    return self._send_json(200, [memory_json(m) for m in items])
            if len(seg) == 3 and seg[0] == "memories" and seg[2] == "decide":
                if method == "POST":
                    body = self._body()
                    item = memories_svc.decide(seg[1], bool(body.get("approved")))
                    return self._send_json(200, memory_json(item))
            if len(seg) == 2 and seg[0] == "memories":
                if method == "DELETE":
                    memories_svc.delete(seg[1])
                    return self._send_json(204, None)
            if seg == ["settings", "connections"] and method == "GET":
                return self._send_json(200, services["settings"].connections())
            if seg == ["files"]:
                if method == "GET":
                    return self._send_json(
                        200, [file_json(f) for f in store.list_files(user)])
            if len(seg) == 3 and seg[0] == "files" and seg[2] == "download":
                if method == "GET":
                    return self._download(seg[1])
            return self._send_json(404, {"error": "not found"})

        def _job_json(self, job: Any) -> dict[str, Any]:
            trigger = {"type": job.trigger_type, **(job.trigger_spec or {})}
            return {"id": job.id, "name": job.name, "script_id": job.script_id,
                    "trigger": trigger, "enabled": job.enabled,
                    "next_run_at": job.next_fire_at,
                    "last_status": services["jobs"].last_status(job.id)}

        def _run_json(self, run: Any, with_events: bool) -> dict[str, Any]:
            title = run.scene
            if run.script_id:
                script = store.get_script(run.script_id)
                title = script.name if script else "脚本运行"
            elif run.chat_id:
                chat = store.get_chat(run.chat_id)
                title = chat.title if chat else run.scene
            out: dict[str, Any] = {
                "id": run.id, "title": title, "kind": run.source,
                "status": run.status.value, "cost_usd": run.cost_usd,
                "created_at": run.created_at}
            if with_events:
                out["events"] = [event_json(e)
                                 for e in store.list_run_events(run.id)]
            return out

        def _download(self, file_id: str) -> None:
            row = next((f for f in store.list_files(user) if f["id"] == file_id),
                       None)
            if row is None:
                raise NotFound(f"文件不存在：{file_id}")
            ref = str(row.get("ref") or "")
            if ref.startswith("script:"):
                script = store.get_script(ref.split(":", 1)[1])
                if script is None:
                    raise NotFound("脚本已不存在")
                content = json.dumps(script.doc, ensure_ascii=False, indent=2)
                return self._send_text(200, content, "application/json",
                                       filename=row["name"])
            raise NotFound("该文件暂不支持下载")

        # ---------- SSE ----------
        def _events(self, run_id: str) -> None:
            if not run_id or store.get_run(run_id) is None:
                raise NotFound(f"运行不存在：{run_id}")
            self.close_connection = True  # 无 Content-Length，靠关连接定界
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            sent = 0
            deadline = time.time() + 120
            try:
                while time.time() < deadline:
                    events = store.list_run_events(run_id)
                    for event in events:
                        if event.seq > sent:
                            sent = event.seq
                            payload = json.dumps(event_json(event),
                                                 ensure_ascii=False)
                            self.wfile.write(
                                f"id: {event.seq}\ndata: {payload}\n\n".encode())
                            self.wfile.flush()
                    run = store.get_run(run_id)
                    caught_up = sent >= (events[-1].seq if events else 0)
                    if run is not None and caught_up and (
                        run.status.value in TERMINAL
                        or run.status == RunStatus.AWAITING_APPROVAL
                    ):
                        break
                    time.sleep(0.3)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler
