import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "../../domain/ports.js";
import type { MemoryRecord } from "../../domain/types.js";

interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  level: string;
  status: string;
  source: string;
  created_at: string;
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    level: row.level,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
  };
}

/** MemoryStore 的 SQLite 实现：decide 为带 pending 前置条件的原子 UPDATE（同 Python）。 */
export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  addMemory(item: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories
           (id, user_id, content, level, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id, item.userId, item.content, item.level, item.status,
        item.source, item.createdAt,
      );
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as unknown as MemoryRow | undefined;
    return row ? toMemory(row) : undefined;
  }

  listMemories(userId: string, status?: string): MemoryRecord[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE user_id = ? AND status = ? ORDER BY created_at, rowid",
            )
            .all(userId, status)
        : this.db
            .prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY created_at, rowid")
            .all(userId)
    ) as unknown as MemoryRow[];
    return rows.map(toMemory);
  }

  decideMemory(id: string, approved: boolean): boolean {
    const result = this.db
      .prepare("UPDATE memories SET status = ? WHERE id = ? AND status = 'pending'")
      .run(approved ? "active" : "rejected", id);
    return Number(result.changes) > 0;
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}
