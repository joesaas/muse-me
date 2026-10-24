import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FileStore } from "../../domain/ports.js";
import type { FileRecord } from "../../domain/types.js";
import { nowIso } from "./database.js";

interface FileRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  ref: string;
  size: number;
  created_at: string;
}

function toFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    kind: row.kind,
    ref: row.ref,
    size: row.size,
    createdAt: row.created_at,
  };
}

/** FileStore 的 SQLite 实现：产物清单（文件本体不落库，下载按 ref 现拼，同 Python）。 */
export class SqliteFileStore implements FileStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 共享连接句柄：seed 整批事务用（见 application/seed.ts）。 */
  get database(): DatabaseSync {
    return this.db;
  }

  addFile(input: {
    userId: string;
    name: string;
    kind: string;
    ref: string;
    size?: number;
  }): FileRecord {
    const record: FileRecord = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      kind: input.kind,
      ref: input.ref,
      size: input.size ?? 0,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        "INSERT INTO files (id, user_id, name, kind, ref, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id, record.userId, record.name, record.kind, record.ref,
        record.size, record.createdAt,
      );
    return record;
  }

  listFiles(userId: string): FileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM files WHERE user_id = ? ORDER BY created_at, rowid")
      .all(userId) as unknown as FileRow[];
    return rows.map(toFile);
  }

  getFile(id: string): FileRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM files WHERE id = ?")
      .get(id) as unknown as FileRow | undefined;
    return row ? toFile(row) : undefined;
  }
}
