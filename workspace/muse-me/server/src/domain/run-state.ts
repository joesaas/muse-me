import { InvalidTransition } from "./errors.js";
import type { RunStatus } from "./types.js";

/**
 * Run 状态机不变量（与 Python 包 domain.py 同一份规则）：
 *   running -> awaiting_approval -> running -> done | failed | cancelled
 * 终态不可再迁移，非法迁移抛 InvalidTransition。
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  running: new Set(["awaiting_approval", "done", "failed", "cancelled"]),
  awaiting_approval: new Set(["running", "failed", "cancelled"]),
  done: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function assertRunTransition(current: RunStatus, target: RunStatus): void {
  if (!RUN_TRANSITIONS[current].has(target)) {
    throw new InvalidTransition(`Run 状态非法迁移：${current} -> ${target}`);
  }
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}
