"""批次三：schema 契约漂移、版本化迁移、显式事务（Python 侧）。

契约解析：直接读 docs/schema-contract.md 的「契约表」一节逐表比对，
契约改了、代码没跟上即失败（反之亦然）。
运行：python3 -m unittest tests.test_batch3_schema_migration -v（仓库根执行，
或 python3 -m unittest discover -s tests）。
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from muse_me.domain import Chat, FeedItem, Script  # noqa: E402
from muse_me.seed import seed_if_empty  # noqa: E402
from muse_me.storage import (  # noqa: E402
    SCHEMA_VERSION,
    SqliteStore,
    get_schema_version,
    migrate,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = REPO_ROOT / "docs" / "schema-contract.md"

# v1 旧库全表定义（迁移测试夹具）：与本批前 storage.py 的 SCHEMA_SQL 一致，
# 差别只有两处——无 run_snapshots 表、feed_items.published_at 为 NOT NULL。
OLD_SCHEMA_SQL = """
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
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(run_id, seq),
    FOREIGN KEY(run_id) REFERENCES runs(id)
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
    decided_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(run_id) REFERENCES runs(id)
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
    published_at TEXT NOT NULL,
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


def parse_contract(path: Path) -> dict[str, list[str]]:
    """解析契约文档「契约表」一节：表名 → 列名列表（按文档顺序）。"""
    tables: dict[str, list[str]] = {}
    current: str | None = None
    in_section = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if line.startswith("## 契约表"):
                in_section = True
                continue
            if in_section:
                break
        if not in_section:
            continue
        if line.startswith("### "):
            current = line[4:].strip()
            tables[current] = []
            continue
        if current is not None and line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if not cells or cells[0] in ("列", "---") or set(cells[0]) <= {"-", " "}:
                continue
            tables[current].append(cells[0])
    return tables


def live_tables(conn: sqlite3.Connection) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
        " AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    for (name,) in rows:
        cols = conn.execute(f"PRAGMA table_info({name})").fetchall()
        out[name] = [c[1] for c in cols]
    return out


def make_old_db(path: str, with_version_row: bool = True) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(OLD_SCHEMA_SQL)
        if with_version_row:
            conn.execute(
                "INSERT INTO schema_meta(key, value) VALUES('version', '1')"
            )
        conn.execute(
            "INSERT INTO chats(id,user_id,title) VALUES('c1','u1','旧聊')"
        )
        conn.execute(
            "INSERT INTO feed_items(id,user_id,title,published_at)"
            " VALUES('f1','u1','旧条目一','2026-10-20T10:00:00+0800')"
        )
        conn.execute(
            "INSERT INTO feed_items(id,user_id,title,published_at)"
            " VALUES('f2','u1','旧条目二','2026-10-21T10:00:00+0800')"
        )
        conn.commit()
    finally:
        conn.close()


class TestContractDrift(unittest.TestCase):
    def test_live_schema_matches_contract(self):
        expected = parse_contract(CONTRACT_PATH)
        self.assertGreater(len(expected), 10, "契约表解析失败：表太少")
        store = SqliteStore(":memory:")
        try:
            actual = live_tables(store.conn)
            self.assertEqual(
                set(actual), set(expected),
                f"表集合漂移：多出 {sorted(set(actual) - set(expected))}，"
                f"缺失 {sorted(set(expected) - set(actual))}",
            )
            for table, cols in expected.items():
                self.assertEqual(
                    set(actual[table]), set(cols),
                    f"表 {table} 列漂移：多出 "
                    f"{sorted(set(actual[table]) - set(cols))}，缺失 "
                    f"{sorted(set(cols) - set(actual[table]))}",
                )
        finally:
            store.close()

    def test_schema_version_and_nullable_published_at(self):
        store = SqliteStore(":memory:")
        try:
            self.assertEqual(SCHEMA_VERSION, 2)
            self.assertEqual(get_schema_version(store.conn), 2)
            cols = store.conn.execute(
                "PRAGMA table_info(feed_items)"
            ).fetchall()
            published = next(c for c in cols if c[1] == "published_at")
            self.assertEqual(published[3], 0, "新库 published_at 必须可空")
            # run_snapshots 占位表存在且可写（Python 不读它，只建表）。
            store.conn.execute(
                "INSERT INTO run_snapshots(run_id,kind,payload,updated_at)"
                " VALUES('r1','awaiting','{}','t')"
            )
            store.conn.commit()
        finally:
            store.close()


class TestMigration(unittest.TestCase):
    def test_old_db_upgrades_and_keeps_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "old.db")
            make_old_db(path)
            store = SqliteStore(path)
            try:
                self.assertEqual(get_schema_version(store.conn), 2)
                items = store.list_feed_items("u1")
                self.assertEqual(
                    [i.title for i in items], ["旧条目二", "旧条目一"]
                )
                cols = store.conn.execute(
                    "PRAGMA table_info(feed_items)"
                ).fetchall()
                published = next(c for c in cols if c[1] == "published_at")
                self.assertEqual(published[3], 0, "迁移后 published_at 必须可空")
                self.assertIsNotNone(store.get_chat("c1"))
                tables = live_tables(store.conn)
                self.assertIn("run_snapshots", tables)
                # 幂等：再跑一次迁移，数据与版本不变。
                self.assertEqual(migrate(store.conn), 2)
                self.assertEqual(len(store.list_feed_items("u1")), 2)
            finally:
                store.close()
            #  reopen：重复打开同样幂等。
            store = SqliteStore(path)
            try:
                self.assertEqual(len(store.list_feed_items("u1")), 2)
                self.assertEqual(get_schema_version(store.conn), 2)
            finally:
                store.close()

    def test_partial_old_db_missing_user_id_column_upgrades(self):
        # 旧库缺 user_id/url 列时迁移不得整库失败：数据保留，user_id 补默认用户。
        import sqlite3 as _sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "partial.db")
            conn = _sqlite3.connect(path)
            conn.execute(
                "CREATE TABLE feed_items (id TEXT PRIMARY KEY,"
                " title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',"
                " source TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '',"
                " entities TEXT NOT NULL DEFAULT '{}',"
                " published_at TEXT NOT NULL DEFAULT '',"
                " prompt_version INTEGER NOT NULL DEFAULT 0,"
                " created_at TEXT NOT NULL DEFAULT '')"
            )
            conn.execute(
                "INSERT INTO feed_items (id, title, published_at)"
                " VALUES ('a', '旧闻一', '2026-10-20T10:00:00+0800')"
            )
            conn.commit()
            conn.close()
            store = SqliteStore(path)
            try:
                self.assertEqual(get_schema_version(store.conn), 2)
                rows = store.conn.execute(
                    "SELECT id, user_id, title FROM feed_items"
                ).fetchall()
                self.assertEqual(
                    [(r[0], r[1], r[2]) for r in rows],
                    [("a", "demo-user", "旧闻一")],
                )
            finally:
                store.close()

    def test_old_db_without_version_row_upgrades(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "noversion.db")
            make_old_db(path, with_version_row=False)
            store = SqliteStore(path)
            try:
                self.assertEqual(get_schema_version(store.conn), 2)
                self.assertEqual(len(store.list_feed_items("u1")), 2)
            finally:
                store.close()

    def test_newer_db_not_downgraded(self):
        store = SqliteStore(":memory:")
        try:
            store.conn.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value)"
                " VALUES('version', '99')"
            )
            store.conn.commit()
            self.assertEqual(migrate(store.conn), 99)
            row = store.conn.execute(
                "SELECT value FROM schema_meta WHERE key='version'"
            ).fetchone()
            self.assertEqual(row[0], "99")
        finally:
            store.close()


class TestTransaction(unittest.TestCase):
    def setUp(self):
        self.store = SqliteStore(":memory:")

    def tearDown(self):
        self.store.close()

    def test_commit_persists(self):
        with self.store.transaction():
            self.store.create_chat(Chat(user_id="u1", title="甲"))
            self.store.create_chat(Chat(user_id="u1", title="乙"))
        self.assertEqual(len(self.store.list_chats("u1")), 2)

    def test_rollback_on_error(self):
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.create_chat(Chat(user_id="u1", title="甲"))
                raise RuntimeError("boom")
        self.assertEqual(len(self.store.list_chats("u1")), 0)

    def test_create_script_atomic(self):
        # 版本写失败时脚本行必须同灭（不能只剩脚本行无版本行）。
        original = self.store.save_script_version

        def failing(_script):
            raise RuntimeError("version write boom")

        self.store.save_script_version = failing  # type: ignore[method-assign]
        try:
            with self.assertRaises(RuntimeError):
                self.store.create_script(
                    Script(user_id="u1", name="s", doc={"a": 1})
                )
        finally:
            self.store.save_script_version = original  # type: ignore[method-assign]
        self.assertEqual(len(self.store.list_scripts("u1")), 0)
        # 正常路径：脚本行与版本行同生。
        script = self.store.create_script(
            Script(user_id="u1", name="s", doc={"a": 1})
        )
        self.assertEqual(len(self.store.list_script_versions(script.id)), 1)

    def test_replace_feed_items_rollback_keeps_old(self):
        self.store.add_feed_item(FeedItem(user_id="u1", title="旧一"))
        self.store.add_feed_item(FeedItem(user_id="u1", title="旧二"))
        original = self.store.add_feed_item
        calls = {"n": 0}

        def failing(item):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise RuntimeError("insert boom")
            return original(item)

        self.store.add_feed_item = failing  # type: ignore[method-assign]
        try:
            with self.assertRaises(RuntimeError):
                self.store.replace_feed_items(
                    "u1",
                    [FeedItem(user_id="u1", title="新一"),
                     FeedItem(user_id="u1", title="新二")],
                )
        finally:
            self.store.add_feed_item = original  # type: ignore[method-assign]
        titles = sorted(i.title for i in self.store.list_feed_items("u1"))
        self.assertEqual(titles, ["旧一", "旧二"])

    def test_seed_rollback(self):
        original = self.store.create_job

        def failing(_job):
            raise RuntimeError("job boom")

        self.store.create_job = failing  # type: ignore[method-assign]
        try:
            with self.assertRaises(RuntimeError):
                seed_if_empty(self.store, user_id="u1")
        finally:
            self.store.create_job = original  # type: ignore[method-assign]
        self.assertEqual(len(self.store.list_scripts("u1")), 0)
        self.assertEqual(len(self.store.list_chats("u1")), 0)
        self.assertIsNone(self.store.get_prompt("u1", "feed"))

    def test_nested_transaction_joins_outer(self):
        with self.store.transaction():
            self.store.create_script(
                Script(user_id="u1", name="s", doc={"a": 1})
            )
        scripts = self.store.list_scripts("u1")
        self.assertEqual(len(scripts), 1)
        self.assertEqual(
            len(self.store.list_script_versions(scripts[0].id)), 1
        )


if __name__ == "__main__":
    unittest.main()
