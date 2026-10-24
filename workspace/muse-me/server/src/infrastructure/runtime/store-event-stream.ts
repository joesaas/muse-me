import type { RunStore } from "../../domain/ports.js";
import { isTerminalRunStatus } from "../../domain/run-state.js";
import type { RunEventRecord } from "../../domain/types.js";

/**
 * 从 RunStore 轮询增量事件的共享实现（Local / AgentCore 两个运行时共用）：
 * 按 seq 增量产出，直到 Run 终态或 awaiting_approval 且已追平，或超时收口。
 */
export async function* pollStoreEvents(
  runs: RunStore,
  runId: string,
  afterSeq = 0,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): AsyncIterable<RunEventRecord> {
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let cursor = afterSeq;
  for (;;) {
    const fresh = runs.listEvents(runId, cursor);
    for (const event of fresh) {
      cursor = event.seq;
      yield event;
    }
    const run = runs.getRun(runId);
    if (run && (isTerminalRunStatus(run.status) || run.status === "awaiting_approval")) {
      // 再拉一轮确保追平后结束
      const rest = runs.listEvents(runId, cursor);
      for (const event of rest) {
        cursor = event.seq;
        yield event;
      }
      return;
    }
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
