import type { FastifyInstance } from "fastify";
import { NotFound } from "../domain/errors.js";
import type { RunStore } from "../domain/ports.js";
import { isTerminalRunStatus } from "../domain/run-state.js";
import { eventJson } from "./serializers.js";

const POLL_MS = 300;
const HEARTBEAT_MS = 15_000;
const MAX_DURATION_MS = 120_000;

/**
 * GET /api/events?run_id=&after= ：SSE 按 seq 增量推送 RunStore 事件。
 * - after（或 Last-Event-ID 头）支持断点续传；
 * - Run 到终态或 awaiting_approval 且已追平时关流（与 Python 版同口径）；
 * - 每 15 秒一条注释心跳保活；最长 120 秒收口。
 */
export function registerEventRoutes(app: FastifyInstance, runs: RunStore): void {
  app.get("/api/events", async (request, reply) => {
    const query = request.query as { run_id?: string; after?: string };
    const runId = query.run_id ?? "";
    if (!runId || !runs.getRun(runId)) {
      throw new NotFound(`运行不存在：${runId}`);
    }
    const headerAfter = Number(request.headers["last-event-id"] ?? NaN);
    const queryAfter = Number(query.after ?? NaN);
    let sent = Number.isFinite(queryAfter)
      ? queryAfter
      : Number.isFinite(headerAfter)
        ? headerAfter
        : 0;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const startedAt = Date.now();
    let closed = false;
    let heartbeatAt = Date.now();
    request.raw.on("close", () => {
      closed = true;
    });

    while (!closed) {
      const fresh = runs.listEvents(runId, sent);
      for (const event of fresh) {
        sent = event.seq;
        reply.raw.write(
          `id: ${event.seq}\ndata: ${JSON.stringify(eventJson(event))}\n\n`,
        );
      }
      const run = runs.getRun(runId);
      const caughtUp = fresh.length === 0;
      if (
        run &&
        caughtUp &&
        (isTerminalRunStatus(run.status) || run.status === "awaiting_approval")
      ) {
        break;
      }
      if (Date.now() - startedAt > MAX_DURATION_MS) break;
      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        heartbeatAt = Date.now();
        reply.raw.write(": ping\n\n");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    reply.raw.end();
  });
}
