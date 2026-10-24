import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite 连接与 schema 初始化（表与 Python 包同名同义，一期四张 + 二期十一张）。
 * 存储用 Node 内置 node:sqlite，不引原生依赖。
 *
 * 版本化迁移（契约见 docs/schema-contract.md）：
 *   v1 基线：此前各表结构（runs 无 tokens/harness_version、无 schema_meta 表；
 *     run_events/approvals 无 FK 声明）。
 *   v2：runs 补 tokens/harness_version（新库建表直接含，旧库由迁移 ALTER 补列）；
 *     run_events/approvals 新库建表含 FK 声明（旧库不强制重建）。
 * openDatabase() 在建表后执行 migrateDatabase()；迁移自身幂等，重复跑不报错。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
    published_at TEXT,  -- 无时间存 NULL，不编造（旧库 NOT NULL 列需重建库）
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
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'inference',
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
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
CREATE TABLE IF NOT EXISTS run_snapshots (
    run_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT ''
);
`;

export const SCHEMA_VERSION = 2;

/** schema_meta 版本行的键（Python 侧历史键为 `version`，见契约差异第 2 条）。 */
export const SCHEMA_META_KEY = "schema_version";

interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function getSchemaVersion(db: DatabaseSync): number {
  const meta = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
    )
    .get() as { name: string } | undefined;
  if (!meta) return 0;
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(SCHEMA_META_KEY) as { value: string } | undefined;
  if (!row) return 0;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 按版本升序的迁移列表：每个 up 先查结构再动手，自身幂等。后续版本按升序追加。 */
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description:
      "runs 补 tokens / harness_version 两列（旧库升级；新库建表已含这两列）",
    up(db: DatabaseSync): void {
      if (!columnExists(db, "runs", "tokens")) {
        db.exec("ALTER TABLE runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "runs", "harness_version")) {
        db.exec(
          "ALTER TABLE runs ADD COLUMN harness_version TEXT NOT NULL DEFAULT ''",
        );
      }
    },
  },
];

/**
 * 把库升级到 SCHEMA_VERSION（幂等）。高于代码版本的库不降级、不动数据。
 * openDatabase() 调用；也可独立调用（测试旧库升级用）。
 */
export function migrateDatabase(db: DatabaseSync): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const version = getSchemaVersion(db);
  if (version > SCHEMA_VERSION) return version;
  let current = version;
  for (const migration of MIGRATIONS) {
    if (current < migration.version) {
      migration.up(db);
      current = migration.version;
    }
  }
  db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)").run(
    SCHEMA_META_KEY,
    String(SCHEMA_VERSION),
  );
  return SCHEMA_VERSION;
}

/** 嵌套事务深度（按连接计）：内层 transaction() 加入外层事务，不另起事务。 */
const txDepth = new WeakMap<DatabaseSync, number>();

/**
 * 显式事务（BE-3）：BEGIN IMMEDIATE，异常回滚、成功提交。
 * 嵌套调用加入外层事务（只由最外层提交/回滚），故自带事务的 store 方法
 * 被 seed 等外层事务包裹时仍正确。
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if ((txDepth.get(db) ?? 0) > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  txDepth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚本身失败（如已无事务）时仍以原异常为准。
    }
    throw err;
  } finally {
    txDepth.delete(db);
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  migrateDatabase(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
