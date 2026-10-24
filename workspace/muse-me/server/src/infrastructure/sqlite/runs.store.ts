import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RunStore } from "../../domain/ports.js";
import type { RunEventDraft, RunEventRecord, RunRecord, RunStatus } from "../../domain/types.js";
import { nowIso } from "./database.js";

interface RunRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  script_id: string | null;
  job_id: string | null;
  scene: string;
  source: string;
  status: string;
  cost_usd: number;
  error: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    userId: row.user_id,
    chatId: row.chat_id,
    scriptId: row.script_id,
    jobId: row.job_id,
    scene: row.scene,
    source: row.source,
    status: row.status as RunStatus,
    costUsd: row.cost_usd,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): RunEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload,
    createdAt: row.created_at,
  };
}

/** RunStore 的 SQLite 实现：runs / run_events 两张表，seq 在单条 INSERT 内分配。 */
export class SqliteRunStore implements RunStore {
  constructor(private readonly db: DatabaseSync) {}

  createRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, user_id, chat_id, script_id, job_id, scene, source,
                           status, cost_usd, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.userId, run.chatId, run.scriptId, run.jobId, run.scene, run.source,
        run.status, run.costUsd, run.error, run.createdAt, run.updatedAt,
      );
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(userId: string): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown as RunRow[];
    return rows.map(toRun);
  }

  updateRunStatus(id: string, status: RunStatus): void {
    this.db
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  setRunError(id: string, error: string): void {
    this.db
      .prepare("UPDATE runs SET error = ?, updated_at = ? WHERE id = ?")
      .run(error, nowIso(), id);
  }

  addRunCost(id: string, amountUsd: number): void {
    this.db
      .prepare("UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?")
      .run(amountUsd, id);
  }

  addEvent(runId: string, draft: RunEventDraft): RunEventRecord {
    const id = randomUUID();
    const createdAt = nowIso();
    // seq 在同一条 INSERT 里用子查询分配，避免读后写竞态（单进程单写者口径）。
    this.db
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, type, payload, created_at)
         VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM run_events WHERE run_id = ?), 0) + 1,
                 ?, ?, ?)`,
      )
      .run(id, runId, runId, draft.type, JSON.stringify(draft.payload ?? {}), createdAt);
    const row = this.db.prepare("SELECT * FROM run_events WHERE id = ?").get(id) as unknown as EventRow;
    return toEvent(row);
  }

  listEvents(runId: string, afterSeq = 0): RunEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
      .all(runId, afterSeq) as unknown as EventRow[];
    return rows.map(toEvent);
  }
}
