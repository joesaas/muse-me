"""SqliteStore：StorePort 的 SQLite 实现（标准库 sqlite3，零 ORM）。

schema 以内嵌字符串 SCHEMA_SQL 为正本（等价 schema.sql），带版本号表 schema_meta。
领域层不见 SQL：repo 方法进出都是 domain 对象。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Any

from .domain import (
    Approval,
    ApprovalStatus,
    Chat,
    FeedItem,
    Job,
    JobRun,
    MemoryItem,
    MemoryStatus,
    Message,
    Notification,
    PromptDoc,
    Run,
    RunEvent,
    RunStatus,
    Script,
    ScriptVersion,
    validate_transition,
)
from .errors import NotFound

SCHEMA_VERSION = 1

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'main',
    feed_item_id TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT,
    script_id TEXT,
    job_id TEXT,
    scene TEXT NOT NULL DEFAULT 'chat',
    source TEXT NOT NULL DEFAULT 'chat',
    status TEXT NOT NULL DEFAULT 'running',
    cost_usd REAL NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    harness_version TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_index INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL DEFAULT '',
    risk TEXT NOT NULL DEFAULT 'write',
    amount_usd REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'inference',
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    doc TEXT NOT NULL DEFAULT '{}',
    current_version INTEGER NOT NULL DEFAULT 1,
    origin_chat_id TEXT,
    origin_feed_item_id TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS script_versions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    doc TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(script_id, version)
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    script_id TEXT NOT NULL,
    script_version INTEGER,
    trigger_type TEXT NOT NULL DEFAULT 'time',
    trigger_spec TEXT NOT NULL DEFAULT '{}',
    params TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    next_fire_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    run_id TEXT,
    script_version INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    attempt INTEGER NOT NULL DEFAULT 1,
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS feed_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    entities TEXT NOT NULL DEFAULT '{}',
    published_at TEXT NOT NULL DEFAULT '',
    prompt_version INTEGER,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(user_id, key, version)
);
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS secrets_ref (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    ref TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ''
);
"""


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    conn.execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', ?)",
        (str(SCHEMA_VERSION),),
    )
    conn.commit()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())


def _j(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def _uj(text: str | None, default: Any) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return default


class SqliteStore:
    """StorePort 实现。path=':memory:' 时为内存库（测试用）。"""

    def __init__(self, path: str = ":memory:"):
        self.path = path
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        init_schema(self.conn)

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def _exec(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def _one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.conn.execute(sql, params).fetchone()

    def _all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.conn.execute(sql, params).fetchall()

    # ---------------- chats / messages ----------------
    def create_chat(self, chat: Chat) -> Chat:
        self._exec(
            "INSERT OR REPLACE INTO chats(id,user_id,title,kind,feed_item_id,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (chat.id, chat.user_id, chat.title, chat.kind, chat.feed_item_id,
             chat.created_at, chat.updated_at),
        )
        return chat

    def get_chat(self, chat_id: str) -> Chat | None:
        row = self._one("SELECT * FROM chats WHERE id=?", (chat_id,))
        return self._chat(row) if row else None

    def list_chats(self, user_id: str) -> list[Chat]:
        rows = self._all(
            "SELECT * FROM chats WHERE user_id=? ORDER BY created_at, rowid", (user_id,)
        )
        return [self._chat(r) for r in rows]

    @staticmethod
    def _chat(row: sqlite3.Row) -> Chat:
        return Chat(
            id=row["id"], user_id=row["user_id"], title=row["title"], kind=row["kind"],
            feed_item_id=row["feed_item_id"], created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def add_message(self, message: Message) -> Message:
        self._exec(
            "INSERT OR REPLACE INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)",
            (message.id, message.chat_id, message.role, message.content, message.created_at),
        )
        return message

    def list_messages(self, chat_id: str) -> list[Message]:
        rows = self._all(
            "SELECT * FROM messages WHERE chat_id=? ORDER BY created_at, rowid", (chat_id,)
        )
        return [
            Message(id=r["id"], chat_id=r["chat_id"], role=r["role"],
                    content=r["content"], created_at=r["created_at"])
            for r in rows
        ]

    # ---------------- runs / run_events ----------------
    def create_run(self, run: Run) -> Run:
        self._exec(
            "INSERT OR REPLACE INTO runs(id,user_id,chat_id,script_id,job_id,scene,source,status,"
            "cost_usd,tokens,harness_version,error,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run.id, run.user_id, run.chat_id, run.script_id, run.job_id, run.scene,
             run.source, run.status.value, run.cost_usd, run.tokens, run.harness_version,
             run.error, run.created_at, run.updated_at),
        )
        return run

    def get_run(self, run_id: str) -> Run | None:
        row = self._one("SELECT * FROM runs WHERE id=?", (run_id,))
        return self._run(row) if row else None

    def list_runs(self, user_id: str) -> list[Run]:
        rows = self._all(
            "SELECT * FROM runs WHERE user_id=? ORDER BY created_at DESC, rowid DESC", (user_id,)
        )
        return [self._run(r) for r in rows]

    @staticmethod
    def _run(row: sqlite3.Row) -> Run:
        return Run(
            id=row["id"], user_id=row["user_id"], chat_id=row["chat_id"],
            script_id=row["script_id"], job_id=row["job_id"], scene=row["scene"],
            source=row["source"], status=RunStatus(row["status"]),
            cost_usd=row["cost_usd"], tokens=row["tokens"],
            harness_version=row["harness_version"], error=row["error"],
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    def update_run_status(self, run_id: str, status: str | RunStatus) -> Run:
        run = self.get_run(run_id)
        if run is None:
            raise NotFound(f"run 不存在：{run_id}")
        run.transition_to(status)  # 非法迁移抛 InvalidTransition
        self._exec(
            "UPDATE runs SET status=?, updated_at=? WHERE id=?",
            (run.status.value, _now(), run_id),
        )
        run.updated_at = _now()
        return run

    def set_run_error(self, run_id: str, error: str) -> None:
        self._exec("UPDATE runs SET error=? WHERE id=?", (error, run_id))

    def add_run_cost(self, run_id: str, cost_usd: float, tokens: int = 0) -> None:
        self._exec(
            "UPDATE runs SET cost_usd=cost_usd+?, tokens=tokens+? WHERE id=?",
            (cost_usd, tokens, run_id),
        )

    def add_run_event(self, event: RunEvent) -> RunEvent:
        if event.seq <= 0:
            row = self._one(
                "SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE run_id=?",
                (event.run_id,),
            )
            event.seq = int(row["m"]) + 1
        self._exec(
            "INSERT OR REPLACE INTO run_events(id,run_id,seq,type,payload,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (event.id, event.run_id, event.seq, event.type, _j(event.payload),
             event.created_at),
        )
        return event

    def list_run_events(self, run_id: str) -> list[RunEvent]:
        rows = self._all(
            "SELECT * FROM run_events WHERE run_id=? ORDER BY seq", (run_id,)
        )
        return [
            RunEvent(id=r["id"], run_id=r["run_id"], seq=r["seq"], type=r["type"],
                     payload=_uj(r["payload"], {}), created_at=r["created_at"])
            for r in rows
        ]

    # ---------------- approvals ----------------
    def create_approval(self, approval: Approval) -> Approval:
        self._exec(
            "INSERT OR REPLACE INTO approvals(id,run_id,step_index,action,risk,amount_usd,"
            "status,reason,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (approval.id, approval.run_id, approval.step_index, approval.action,
             approval.risk, approval.amount_usd, approval.status.value,
             approval.reason, approval.created_at, approval.decided_at),
        )
        return approval

    def get_approval(self, approval_id: str) -> Approval | None:
        row = self._one("SELECT * FROM approvals WHERE id=?", (approval_id,))
        return self._approval(row) if row else None

    def list_approvals(
        self, user_id: str | None = None, status: str | None = None
    ) -> list[Approval]:
        # approvals 表不冗余 user_id，经 runs 关联过滤（user_id 为 None 时不过滤）
        if user_id is None:
            if status is None:
                rows = self._all("SELECT * FROM approvals ORDER BY created_at")
            else:
                rows = self._all(
                    "SELECT * FROM approvals WHERE status=? ORDER BY created_at",
                    (status,),
                )
        elif status is None:
            rows = self._all(
                "SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id"
                " WHERE r.user_id=? ORDER BY a.created_at",
                (user_id,),
            )
        else:
            rows = self._all(
                "SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id"
                " WHERE r.user_id=? AND a.status=? ORDER BY a.created_at",
                (user_id, status),
            )
        return [self._approval(r) for r in rows]

    @staticmethod
    def _approval(row: sqlite3.Row) -> Approval:
        return Approval(
            id=row["id"], run_id=row["run_id"], step_index=row["step_index"],
            action=row["action"], risk=row["risk"], amount_usd=row["amount_usd"],
            status=ApprovalStatus(row["status"]), reason=row["reason"],
            created_at=row["created_at"], decided_at=row["decided_at"],
        )

    def decide_approval(
        self, approval_id: str, decision: str, reason: str = ""
    ) -> Approval:
        approval = self.get_approval(approval_id)
        if approval is None:
            raise NotFound(f"approval 不存在：{approval_id}")
        return self._decide_approval(approval, decision, reason)

    def _decide_approval(self, approval: Approval, decision: str, reason: str) -> Approval:
        from .errors import DemoError

        if approval.status != ApprovalStatus.PENDING:
            raise DemoError(f"approval 已决策，不可重复决策：{approval.id}")
        if decision not in ("approved", "denied"):
            raise DemoError(f"非法 decision：{decision}")
        approval.status = ApprovalStatus(decision)
        approval.reason = reason
        approval.decided_at = _now()
        self._exec(
            "UPDATE approvals SET status=?, reason=?, decided_at=? WHERE id=?",
            (approval.status.value, reason, approval.decided_at, approval.id),
        )
        return approval

    # ---------------- memories ----------------
    def add_memory(self, item: MemoryItem) -> MemoryItem:
        self._exec(
            "INSERT OR REPLACE INTO memories(id,user_id,content,level,status,source,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (item.id, item.user_id, item.content, item.level, item.status,
             item.source, item.created_at),
        )
        return item

    def get_memory(self, memory_id: str) -> MemoryItem | None:
        row = self._one("SELECT * FROM memories WHERE id=?", (memory_id,))
        return self._memory(row) if row else None

    def list_memories(
        self, user_id: str, status: str | None = None
    ) -> list[MemoryItem]:
        if status is None:
            rows = self._all(
                "SELECT * FROM memories WHERE user_id=? ORDER BY created_at", (user_id,)
            )
        else:
            rows = self._all(
                "SELECT * FROM memories WHERE user_id=? AND status=? ORDER BY created_at",
                (user_id, status),
            )
        return [self._memory(r) for r in rows]

    @staticmethod
    def _memory(row: sqlite3.Row) -> MemoryItem:
        return MemoryItem(
            id=row["id"], user_id=row["user_id"], content=row["content"],
            level=row["level"], status=row["status"], source=row["source"],
            created_at=row["created_at"],
        )

    def decide_memory(self, memory_id: str, approved: bool) -> MemoryItem:
        item = self.get_memory(memory_id)
        if item is None:
            raise NotFound(f"memory 不存在：{memory_id}")
        item.status = (
            MemoryStatus.ACTIVE.value if approved else MemoryStatus.REJECTED.value
        )
        self._exec(
            "UPDATE memories SET status=? WHERE id=?", (item.status, memory_id)
        )
        return item

    def delete_memory(self, memory_id: str) -> bool:
        cur = self._exec("DELETE FROM memories WHERE id=?", (memory_id,))
        return cur.rowcount > 0

    # ---------------- scripts / script_versions ----------------
    def create_script(self, script: Script) -> Script:
        self._exec(
            "INSERT OR REPLACE INTO scripts(id,user_id,name,description,doc,current_version,"
            "origin_chat_id,origin_feed_item_id,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (script.id, script.user_id, script.name, script.description, _j(script.doc),
             script.current_version, script.origin_chat_id, script.origin_feed_item_id,
             script.created_at, script.updated_at),
        )
        self.save_script_version(script)
        return script

    def get_script(self, script_id: str) -> Script | None:
        row = self._one("SELECT * FROM scripts WHERE id=?", (script_id,))
        return self._script(row) if row else None

    def list_scripts(self, user_id: str) -> list[Script]:
        rows = self._all(
            "SELECT * FROM scripts WHERE user_id=? ORDER BY created_at", (user_id,)
        )
        return [self._script(r) for r in rows]

    @staticmethod
    def _script(row: sqlite3.Row) -> Script:
        return Script(
            id=row["id"], user_id=row["user_id"], name=row["name"],
            description=row["description"], doc=_uj(row["doc"], {}),
            current_version=row["current_version"], origin_chat_id=row["origin_chat_id"],
            origin_feed_item_id=row["origin_feed_item_id"],
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    def update_script(self, script: Script) -> Script:
        """保存修改：版本号递增并落一条新 ScriptVersion。"""
        script.current_version += 1
        script.updated_at = _now()
        self._exec(
            "UPDATE scripts SET name=?, description=?, doc=?, current_version=?, updated_at=?"
            " WHERE id=?",
            (script.name, script.description, _j(script.doc), script.current_version,
             script.updated_at, script.id),
        )
        self.save_script_version(script)
        return script

    def save_script_version(self, script: Script) -> ScriptVersion:
        version = ScriptVersion(
            script_id=script.id, version=script.current_version, doc=dict(script.doc),
            created_at=_now(),
        )
        self._exec(
            "INSERT OR REPLACE INTO script_versions(id,script_id,version,doc,created_at)"
            " VALUES(?,?,?,?,?)",
            (version.id, version.script_id, version.version, _j(version.doc),
             version.created_at),
        )
        return version

    def list_script_versions(self, script_id: str) -> list[ScriptVersion]:
        rows = self._all(
            "SELECT * FROM script_versions WHERE script_id=? ORDER BY version", (script_id,)
        )
        return [self._version(r) for r in rows]

    def get_script_version(
        self, script_id: str, version: int
    ) -> ScriptVersion | None:
        row = self._one(
            "SELECT * FROM script_versions WHERE script_id=? AND version=?",
            (script_id, version),
        )
        return self._version(row) if row else None

    @staticmethod
    def _version(row: sqlite3.Row) -> ScriptVersion:
        return ScriptVersion(
            id=row["id"], script_id=row["script_id"], version=row["version"],
            doc=_uj(row["doc"], {}), created_at=row["created_at"],
        )

    # ---------------- jobs / job_runs ----------------
    def create_job(self, job: Job) -> Job:
        self._exec(
            "INSERT OR REPLACE INTO jobs(id,user_id,name,script_id,script_version,trigger_type,"
            "trigger_spec,params,enabled,next_fire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (job.id, job.user_id, job.name, job.script_id, job.script_version,
             job.trigger_type, _j(job.trigger_spec), _j(job.params),
             1 if job.enabled else 0, job.next_fire_at, job.created_at),
        )
        return job

    def get_job(self, job_id: str) -> Job | None:
        row = self._one("SELECT * FROM jobs WHERE id=?", (job_id,))
        return self._job(row) if row else None

    def list_jobs(self, user_id: str) -> list[Job]:
        rows = self._all(
            "SELECT * FROM jobs WHERE user_id=? ORDER BY created_at", (user_id,)
        )
        return [self._job(r) for r in rows]

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        return Job(
            id=row["id"], user_id=row["user_id"], name=row["name"],
            script_id=row["script_id"], script_version=row["script_version"],
            trigger_type=row["trigger_type"], trigger_spec=_uj(row["trigger_spec"], {}),
            params=_uj(row["params"], {}), enabled=bool(row["enabled"]),
            next_fire_at=row["next_fire_at"], created_at=row["created_at"],
        )

    def update_job(self, job: Job) -> Job:
        self._exec(
            "UPDATE jobs SET name=?, script_id=?, script_version=?, trigger_type=?,"
            " trigger_spec=?, params=?, enabled=?, next_fire_at=? WHERE id=?",
            (job.name, job.script_id, job.script_version, job.trigger_type,
             _j(job.trigger_spec), _j(job.params), 1 if job.enabled else 0,
             job.next_fire_at, job.id),
        )
        return job

    def add_job_run(self, job_run: JobRun) -> JobRun:
        self._exec(
            "INSERT OR REPLACE INTO job_runs(id,job_id,run_id,script_version,status,attempt,"
            "error,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (job_run.id, job_run.job_id, job_run.run_id, job_run.script_version,
             job_run.status, job_run.attempt, job_run.error, job_run.started_at,
             job_run.finished_at),
        )
        return job_run

    def list_job_runs(self, job_id: str) -> list[JobRun]:
        rows = self._all(
            "SELECT * FROM job_runs WHERE job_id=? ORDER BY started_at, rowid", (job_id,)
        )
        return [
            JobRun(id=r["id"], job_id=r["job_id"], run_id=r["run_id"],
                   script_version=r["script_version"], status=r["status"],
                   attempt=r["attempt"], error=r["error"],
                   started_at=r["started_at"], finished_at=r["finished_at"])
            for r in rows
        ]

    # ---------------- feed ----------------
    def add_feed_item(self, item: FeedItem) -> FeedItem:
        self._exec(
            "INSERT OR REPLACE INTO feed_items(id,user_id,title,summary,source,url,topic,"
            "entities,published_at,prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (item.id, item.user_id, item.title, item.summary, item.source, item.url,
             item.topic, _j(item.entities), item.published_at, item.prompt_version,
             item.created_at),
        )
        return item

    def get_feed_item(self, item_id: str) -> FeedItem | None:
        row = self._one("SELECT * FROM feed_items WHERE id=?", (item_id,))
        return self._feed_item(row) if row else None

    def list_feed_items(self, user_id: str, limit: int = 50) -> list[FeedItem]:
        rows = self._all(
            "SELECT * FROM feed_items WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (user_id, limit),
        )
        return [self._feed_item(r) for r in rows]

    def replace_feed_items(self, user_id: str, items: list[FeedItem]) -> None:
        self._exec("DELETE FROM feed_items WHERE user_id=?", (user_id,))
        for item in items:
            item.user_id = user_id
            self.add_feed_item(item)

    @staticmethod
    def _feed_item(row: sqlite3.Row) -> FeedItem:
        return FeedItem(
            id=row["id"], user_id=row["user_id"], title=row["title"],
            summary=row["summary"], source=row["source"], url=row["url"],
            topic=row["topic"], entities=_uj(row["entities"], {}),
            published_at=row["published_at"], prompt_version=row["prompt_version"],
            created_at=row["created_at"],
        )

    # ---------------- prompts（版本化） ----------------
    def get_prompt(self, user_id: str, key: str) -> PromptDoc | None:
        row = self._one(
            "SELECT * FROM prompts WHERE user_id=? AND key=? ORDER BY version DESC LIMIT 1",
            (user_id, key),
        )
        return self._prompt(row) if row else None

    def set_prompt(self, user_id: str, key: str, content: str) -> PromptDoc:
        current = self.get_prompt(user_id, key)
        version = (current.version + 1) if current else 1
        doc = PromptDoc(user_id=user_id, key=key, content=content, version=version)
        self._exec(
            "INSERT INTO prompts(id,user_id,key,version,content,created_at) VALUES(?,?,?,?,?,?)",
            (doc.id, user_id, key, version, content, doc.created_at),
        )
        return doc

    def list_prompt_versions(self, user_id: str, key: str) -> list[PromptDoc]:
        rows = self._all(
            "SELECT * FROM prompts WHERE user_id=? AND key=? ORDER BY version",
            (user_id, key),
        )
        return [self._prompt(r) for r in rows]

    @staticmethod
    def _prompt(row: sqlite3.Row) -> PromptDoc:
        return PromptDoc(
            id=row["id"], user_id=row["user_id"], key=row["key"],
            content=row["content"], version=row["version"], created_at=row["created_at"],
        )

    # ---------------- notifications ----------------
    def add_notification(self, note: Notification) -> Notification:
        self._exec(
            "INSERT OR REPLACE INTO notifications(id,user_id,kind,title,body,read,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (note.id, note.user_id, note.kind, note.title, note.body,
             1 if note.read else 0, note.created_at),
        )
        return note

    def list_notifications(
        self, user_id: str, unread_only: bool = False
    ) -> list[Notification]:
        if unread_only:
            rows = self._all(
                "SELECT * FROM notifications WHERE user_id=? AND read=0 ORDER BY created_at",
                (user_id,),
            )
        else:
            rows = self._all(
                "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at", (user_id,)
            )
        return [
            Notification(id=r["id"], user_id=r["user_id"], kind=r["kind"],
                           title=r["title"], body=r["body"], read=bool(r["read"]),
                           created_at=r["created_at"])
            for r in rows
        ]

    def mark_notification_read(self, notification_id: str) -> bool:
        cur = self._exec(
            "UPDATE notifications SET read=1 WHERE id=?", (notification_id,)
        )
        return cur.rowcount > 0

    # ---------------- secrets_ref（只存引用） ----------------
    def set_secret_ref(self, user_id: str, name: str, ref: str) -> None:
        self._exec(
            "INSERT OR REPLACE INTO secrets_ref(id,user_id,name,ref,created_at) VALUES(?,?,?,?,?)",
            (uuid.uuid4().hex, user_id, name, ref, _now()),
        )

    def get_secret_ref(self, user_id: str, name: str) -> str | None:
        row = self._one(
            "SELECT ref FROM secrets_ref WHERE user_id=? AND name=?", (user_id, name)
        )
        return row["ref"] if row else None

    def list_secrets_ref(self, user_id: str) -> list[dict[str, str]]:
        rows = self._all(
            "SELECT name, ref, created_at FROM secrets_ref WHERE user_id=? ORDER BY name",
            (user_id,),
        )
        return [
            {"name": r["name"], "ref": r["ref"], "created_at": r["created_at"]}
            for r in rows
        ]

    # ---------------- files（产物清单） ----------------
    def add_file(
        self, user_id: str, name: str, kind: str, ref: str, size: int = 0
    ) -> dict[str, Any]:
        fid = uuid.uuid4().hex
        created = _now()
        self._exec(
            "INSERT INTO files(id,user_id,name,kind,ref,size,created_at) VALUES(?,?,?,?,?,?,?)",
            (fid, user_id, name, kind, ref, size, created),
        )
        return {"id": fid, "user_id": user_id, "name": name, "kind": kind,
                "ref": ref, "size": size, "created_at": created}

    def list_files(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._all(
            "SELECT * FROM files WHERE user_id=? ORDER BY created_at", (user_id,)
        )
        return [
            {"id": r["id"], "user_id": r["user_id"], "name": r["name"],
             "kind": r["kind"], "ref": r["ref"], "size": r["size"],
             "created_at": r["created_at"]}
            for r in rows
        ]
