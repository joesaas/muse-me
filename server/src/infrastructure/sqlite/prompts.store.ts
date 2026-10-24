import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PromptStore } from "../../domain/ports.js";
import type { PromptRecord } from "../../domain/types.js";
import { nowIso } from "./database.js";

interface PromptRow {
  id: string;
  user_id: string;
  key: string;
  version: number;
  content: string;
  created_at: string;
}

function toPrompt(row: PromptRow): PromptRecord {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
  };
}

/** PromptStore 的 SQLite 实现：版本化存储，setPrompt 每次生成递增新版本。 */
export class SqlitePromptStore implements PromptStore {
  constructor(private readonly db: DatabaseSync) {}

  getPrompt(userId: string, key: string): PromptRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM prompts WHERE user_id = ? AND key = ? ORDER BY version DESC LIMIT 1",
      )
      .get(userId, key) as unknown as PromptRow | undefined;
    return row ? toPrompt(row) : undefined;
  }

  setPrompt(userId: string, key: string, content: string): PromptRecord {
    // 读当前版本与插入新版本在同一同步调用内完成（node:sqlite 同步 API，
    // 无 await 间隙），等价于 Python 的类级锁口径；UNIQUE 约束兜底。
    const current = this.getPrompt(userId, key);
    const doc: PromptRecord = {
      id: randomUUID(),
      userId,
      key,
      content,
      version: (current?.version ?? 0) + 1,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        "INSERT INTO prompts (id, user_id, key, version, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(doc.id, userId, key, doc.version, content, doc.createdAt);
    return doc;
  }

  listPromptVersions(userId: string, key: string): PromptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM prompts WHERE user_id = ? AND key = ? ORDER BY version")
      .all(userId, key) as unknown as PromptRow[];
    return rows.map(toPrompt);
  }
}
