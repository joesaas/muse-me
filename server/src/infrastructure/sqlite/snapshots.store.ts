import type { DatabaseSync } from "node:sqlite";
import type { RunSnapshotStore } from "../../domain/ports.js";
import type { RunSnapshotRecord } from "../../domain/types.js";
import { nowIso } from "./database.js";
import { parseJsonObject } from "./json.js";

/**
 * RunSnapshotStore 的 SQLite 实现：挂起运行的续跑快照落 run_snapshots 表，
 * server 重启后 LocalRuntime 从这里重建挂起态（不再只靠进程内存）。
 */
export class SqliteRunSnapshotStore implements RunSnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  saveSnapshot(runId: string, kind: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_snapshots (run_id, kind, payload, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, kind, JSON.stringify(payload ?? {}), nowIso());
  }

  getSnapshot(runId: string): RunSnapshotRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM run_snapshots WHERE run_id = ?")
      .get(runId) as
      | { run_id: string; kind: string; payload: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      kind: row.kind,
      payload: parseJsonObject(row.payload),
      updatedAt: row.updated_at,
    };
  }

  deleteSnapshot(runId: string): void {
    this.db.prepare("DELETE FROM run_snapshots WHERE run_id = ?").run(runId);
  }
}
