import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seedIfEmpty } from "../src/application/seed.js";
import {
  SCHEMA_META_KEY,
  SCHEMA_VERSION,
  migrateDatabase,
  openDatabase,
  transaction,
} from "../src/infrastructure/sqlite/database.js";
import { SqliteChatStore } from "../src/infrastructure/sqlite/chats.store.js";
import { SqliteFeedStore } from "../src/infrastructure/sqlite/feed.store.js";
import { SqliteFileStore } from "../src/infrastructure/sqlite/files.store.js";
import { SqliteJobStore } from "../src/infrastructure/sqlite/jobs.store.js";
import { SqliteMemoryStore } from "../src/infrastructure/sqlite/memories.store.js";
import { SqlitePromptStore } from "../src/infrastructure/sqlite/prompts.store.js";
import { SqliteScriptStore } from "../src/infrastructure/sqlite/scripts.store.js";
import type { FeedItemRecord, JobRecord } from "../src/domain/types.js";

const CONTRACT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "schema-contract.md",
);

/** 解析契约文档「契约表」一节：表名 → 列名列表（与 Python 测试同口径）。 */
function parseContract(text: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const lines = text.split("\n");
  let inSection = false;
  let current: string | undefined;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (line.startsWith("## 契约表")) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }
    if (!inSection) continue;
    if (line.startsWith("### ")) {
      current = line.slice(4).trim();
      tables.set(current, []);
      continue;
    }
    if (current && line.startsWith("|")) {
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      if (!cells[0] || cells[0] === "列" || /^-+$/.test(cells[0])) continue;
      tables.get(current)!.push(cells[0]);
    }
  }
  return tables;
}

function liveSchema(db: DatabaseSync): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of rows) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string;
    }>;
    tables.set(
      name,
      cols.map((c) => c.name),
    );
  }
  return tables;
}

/** 契约明文允许的唯一缺表：users 仅 Python 有（差异第 1 条）。 */
const ALLOWED_MISSING_TABLES = new Set(["users"]);

function makeScript(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    userId: "u1",
    name: "s",
    description: "",
    doc: { a: 1 },
    currentVersion: 1,
    originChatId: null,
    originFeedItemId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeFeedItem(id: string, title: string): FeedItemRecord {
  return {
    id,
    userId: "u1",
    title,
    summary: "",
    source: "",
    url: "",
    topic: "",
    entities: {},
    publishedAt: null,
    promptVersion: null,
    createdAt: new Date().toISOString(),
  };
}

describe("schema 契约漂移（解析 docs/schema-contract.md 比对）", () => {
  it("新库表/列集合与契约一致（除明文允许的 users 缺表）", () => {
    const expected = parseContract(readFileSync(CONTRACT_PATH, "utf8"));
    expect(expected.size).toBeGreaterThan(10);
    const db = openDatabase(":memory:");
    try {
      const actual = liveSchema(db);
      const missing = [...expected.keys()].filter(
        (t) => !actual.has(t) && !ALLOWED_MISSING_TABLES.has(t),
      );
      const extra = [...actual.keys()].filter((t) => !expected.has(t));
      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
      for (const [table, cols] of expected) {
        if (!actual.has(table)) continue;
        expect([...actual.get(table)!].sort()).toEqual([...cols].sort());
      }
    } finally {
      db.close();
    }
  });

  it("版本行与 v2 列、FK 声明", () => {
    expect(SCHEMA_VERSION).toBe(2);
    const db = openDatabase(":memory:");
    try {
      const row = db
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .get(SCHEMA_META_KEY) as { value: string };
      expect(row.value).toBe("2");
      const runsCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{
        name: string;
      }>;
      const names = runsCols.map((c) => c.name);
      expect(names).toContain("tokens");
      expect(names).toContain("harness_version");
      // 新库 run_events / approvals 建表 SQL 含 FK 声明。
      for (const table of ["run_events", "approvals"]) {
        const sqlRow = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string };
        expect(sqlRow.sql).toContain("FOREIGN KEY(run_id) REFERENCES runs(id)");
      }
    } finally {
      db.close();
    }
  });
});

describe("旧库迁移（v1 runs 无 tokens/harness_version）", () => {
  it("openDatabase 补列、保数据、写版本 2，重复打开幂等", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "museme-schema-"));
    const dbPath = path.join(dir, "old.db");
    try {
      // 先造一份 v1 旧库：只有旧 runs 表 + 一条数据，无 schema_meta。
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec(`
          CREATE TABLE runs (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT,
            script_id TEXT, job_id TEXT, scene TEXT NOT NULL DEFAULT 'chat',
            source TEXT NOT NULL DEFAULT 'chat', status TEXT NOT NULL DEFAULT 'running',
            cost_usd REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
          );
        `);
        raw
          .prepare(
            "INSERT INTO runs (id, user_id, status, cost_usd) VALUES (?, ?, ?, ?)",
          )
          .run("r1", "u1", "done", 1.5);
        raw.close();
      }
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("SELECT * FROM runs WHERE id = ?").get("r1") as {
          status: string;
          cost_usd: number;
          tokens: number;
          harness_version: string;
        };
        expect(row.status).toBe("done");
        expect(row.cost_usd).toBe(1.5);
        expect(row.tokens).toBe(0);
        expect(row.harness_version).toBe("");
        const version = db
          .prepare("SELECT value FROM schema_meta WHERE key = ?")
          .get(SCHEMA_META_KEY) as { value: string };
        expect(version.value).toBe("2");
        // migrateDatabase 直接重跑同样幂等。
        expect(migrateDatabase(db)).toBe(2);
      } finally {
        db.close();
      }
      // 再打开一次：不报错、数据仍在、版本仍为 2。
      const db2 = openDatabase(dbPath);
      try {
        expect(
          (db2.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
        ).toBe(1);
        expect(
          (
            db2
              .prepare("SELECT value FROM schema_meta WHERE key = ?")
              .get(SCHEMA_META_KEY) as { value: string }
          ).value,
        ).toBe("2");
      } finally {
        db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("显式事务（BE-3）", () => {
  it("提交持久化、异常回滚（脚本行与版本行同生同灭）", () => {
    const db = openDatabase(":memory:");
    try {
      const scripts = new SqliteScriptStore(db);
      transaction(db, () => {
        scripts.createScript(makeScript("s1"));
      });
      expect(scripts.getScript("s1")).toBeDefined();
      expect(scripts.getScriptVersion("s1", 1)).toBeDefined();

      expect(() =>
        transaction(db, () => {
          scripts.createScript(makeScript("s2"));
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(scripts.getScript("s2")).toBeUndefined();
      const versionRows = db
        .prepare("SELECT COUNT(*) AS n FROM script_versions WHERE script_id = ?")
        .get("s2") as { n: number };
      expect(versionRows.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("feed 替换中途失败时旧数据仍在", () => {
    const db = openDatabase(":memory:");
    try {
      const feed = new SqliteFeedStore(db);
      feed.replaceFeedItems("u1", [
        makeFeedItem("old1", "旧一"),
        makeFeedItem("old2", "旧二"),
      ]);
      // 失败注入：publishedAt 传 undefined 会在绑定期抛错（不能用 title=null，
      // SQLite 的 INSERT OR REPLACE 会把 NOT NULL 冲突用默认值顶掉而不报错）。
      const bad = {
        ...makeFeedItem("new2", "新二"),
        publishedAt: undefined as unknown as string | null,
      };
      expect(() =>
        feed.replaceFeedItems("u1", [makeFeedItem("new1", "新一"), bad]),
      ).toThrow();
      expect(feed.listFeedItems("u1").map((i) => i.title).sort()).toEqual([
        "旧一",
        "旧二",
      ]);
    } finally {
      db.close();
    }
  });

  it("seed 整批中途失败时整批回滚", () => {
    const db = openDatabase(":memory:");
    try {
      const chats = new SqliteChatStore(db);
      const prompts = new SqlitePromptStore(db);
      const scripts = new SqliteScriptStore(db);
      const files = new SqliteFileStore(db);
      const realJobs = new SqliteJobStore(db);
      const memories = new SqliteMemoryStore(db);
      // jobs 包装成失败实现，但不带 database 句柄：其余五个 store 仍共享
      // 同一连接，seed 应取到唯一连接包事务并回滚已写的脚本/提示词/主聊。
      const failingJobs = {
        createJob(_job: JobRecord): void {
          throw new Error("job boom");
        },
        getJob: (id: string) => realJobs.getJob(id),
        listJobs: (userId: string) => realJobs.listJobs(userId),
        updateJob: (job: JobRecord) => realJobs.updateJob(job),
        addJobRun: (run: Parameters<SqliteJobStore["addJobRun"]>[0]) =>
          realJobs.addJobRun(run),
        listJobRuns: (jobId: string) => realJobs.listJobRuns(jobId),
      };
      expect(() =>
        seedIfEmpty(
          {
            chats,
            prompts,
            scripts,
            files,
            jobs: failingJobs,
            memories,
          },
          "u1",
        ),
      ).toThrow("job boom");
      expect(scripts.listScripts("u1")).toHaveLength(0);
      expect(prompts.getPrompt("u1", "feed")).toBeUndefined();
      expect(chats.listChats("u1")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("seed 成功路径仍正常且二次调用跳过", () => {
    const db = openDatabase(":memory:");
    try {
      const stores = {
        chats: new SqliteChatStore(db),
        prompts: new SqlitePromptStore(db),
        scripts: new SqliteScriptStore(db),
        files: new SqliteFileStore(db),
        jobs: new SqliteJobStore(db),
        memories: new SqliteMemoryStore(db),
      };
      expect(seedIfEmpty(stores, "u1")).toBe(true);
      expect(stores.scripts.listScripts("u1")).toHaveLength(2);
      expect(seedIfEmpty(stores, "u1")).toBe(false);
    } finally {
      db.close();
    }
  });
});
