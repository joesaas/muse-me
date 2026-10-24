import type { DatabaseSync } from "node:sqlite";
import type { ApprovalStore } from "../../domain/ports.js";
import type { Approval, ApprovalStatus } from "../../domain/types.js";
import { nowIso } from "./database.js";

interface ApprovalRow {
  id: string;
  run_id: string;
  step_index: number;
  action: string;
  risk: string;
  amount_usd: number | null;
  status: string;
  reason: string;
  created_at: string;
  decided_at: string;
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    stepIndex: row.step_index,
    action: row.action,
    risk: row.risk,
    amountUsd: row.amount_usd,
    status: row.status as ApprovalStatus,
    reason: row.reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/** ApprovalStore 的 SQLite 实现：决策是带 status 条件的一条 UPDATE（原子口径）。 */
export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly db: DatabaseSync) {}

  createApproval(approval: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, step_index, action, risk, amount_usd,
                                status, reason, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id, approval.runId, approval.stepIndex, approval.action, approval.risk,
        approval.amountUsd, approval.status, approval.reason, approval.createdAt,
        approval.decidedAt,
      );
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row ? toApproval(row) : undefined;
  }

  listApprovals(userId: string, status?: string): Approval[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT a.* FROM approvals a JOIN runs r ON r.id = a.run_id
               WHERE r.user_id = ? AND a.status = ? ORDER BY a.created_at DESC`,
            )
            .all(userId, status)
        : this.db
            .prepare(
              `SELECT a.* FROM approvals a JOIN runs r ON r.id = a.run_id
               WHERE r.user_id = ? ORDER BY a.created_at DESC`,
            )
            .all(userId)
    ) as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }

  decideApproval(id: string, decision: "approved" | "denied", reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, reason = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, reason, nowIso(), id);
    return Number(result.changes) > 0;
  }
}
