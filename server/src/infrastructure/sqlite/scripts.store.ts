import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ScriptStore } from "../../domain/ports.js";
import type { ScriptRecord, ScriptVersionRecord } from "../../domain/types.js";
import { nowIso, transaction } from "./database.js";
import { parseJsonObject } from "./json.js";

interface ScriptRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  doc: string;
  current_version: number;
  origin_chat_id: string | null;
  origin_feed_item_id: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  script_id: string;
  version: number;
  doc: string;
  created_at: string;
}

function toScript(row: ScriptRow): ScriptRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    doc: parseJsonObject(row.doc),
    currentVersion: row.current_version,
    originChatId: row.origin_chat_id,
    originFeedItemId: row.origin_feed_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** ScriptStore 的 SQLite 实现：scripts + script_versions 两张表（同 Python storage）。 */
export class SqliteScriptStore implements ScriptStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 共享连接句柄：seed 整批事务用（组合根不改时，seed 从各 store 取唯一
   * 共享连接包事务；见 application/seed.ts）。
   */
  get database(): DatabaseSync {
    return this.db;
  }

  createScript(script: ScriptRecord): ScriptRecord {
    // 脚本行与版本行同生同灭：两写包在同一事务内。
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO scripts
           (id, user_id, name, description, doc, current_version,
            origin_chat_id, origin_feed_item_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          script.id, script.userId, script.name, script.description,
          JSON.stringify(script.doc ?? {}), script.currentVersion,
          script.originChatId, script.originFeedItemId, script.createdAt,
          script.updatedAt,
        );
      this.saveVersion(script);
      return script;
    });
  }

  getScript(id: string): ScriptRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM scripts WHERE id = ?")
      .get(id) as unknown as ScriptRow | undefined;
    return row ? toScript(row) : undefined;
  }

  listScripts(userId: string): ScriptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM scripts WHERE user_id = ? ORDER BY created_at")
      .all(userId) as unknown as ScriptRow[];
    return rows.map(toScript);
  }

  updateScript(script: ScriptRecord): ScriptRecord {
    // 与 Python update_script 同口径：版本号递增并落一条新版本记录；
    // UPDATE 只写 name/description/doc/current_version/updated_at（不写来源字段）。
    // 两写同一事务（同 createScript）。
    script.currentVersion += 1;
    script.updatedAt = nowIso();
    return transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE scripts SET name = ?, description = ?, doc = ?,
                current_version = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          script.name, script.description, JSON.stringify(script.doc ?? {}),
          script.currentVersion, script.updatedAt, script.id,
        );
      this.saveVersion(script);
      return script;
    });
  }

  getScriptVersion(
    scriptId: string,
    version: number,
  ): ScriptVersionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM script_versions WHERE script_id = ? AND version = ?")
      .get(scriptId, version) as unknown as VersionRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      scriptId: row.script_id,
      version: row.version,
      doc: parseJsonObject(row.doc),
      createdAt: row.created_at,
    };
  }

  private saveVersion(script: ScriptRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO script_versions (id, script_id, version, doc, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), script.id, script.currentVersion,
        JSON.stringify(script.doc ?? {}), nowIso(),
      );
  }
}
