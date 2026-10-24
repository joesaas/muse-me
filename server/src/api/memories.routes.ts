import type { FastifyInstance } from "fastify";
import type { MemoryService } from "../application/memory.service.js";
import { parseApprovedFlag } from "./approvals.routes.js";
import { bodyOf } from "./auth.routes.js";
import { memoryJson } from "./serializers.js";

/**
 * 记忆薄控制器。GET 在此过滤 rejected（同 Python api.py 的 API 层口径）；
 * decide 的 approved 严校验 JSON 布尔；DELETE 成功 204 无 body。
 * POST /api/memories 为任务书口径新增（Python 版 MemoryService.add 未挂路由），
 * 分级语义与 Python 服务层一致。
 */
export function registerMemoryRoutes(
  app: FastifyInstance,
  memories: MemoryService,
): void {
  app.get("/api/memories", async () =>
    memories
      .list()
      .filter((m) => m.status !== "rejected")
      .map(memoryJson),
  );

  app.post("/api/memories", async (request) => {
    const body = bodyOf(request);
    const item = memories.add(
      String(body.content ?? ""),
      typeof body.level === "string" ? body.level : undefined,
      typeof body.source === "string" ? body.source : "",
    );
    return memoryJson(item);
  });

  app.post("/api/memories/:id/decide", async (request) => {
    const { id } = request.params as { id: string };
    const approved = parseApprovedFlag(bodyOf(request));
    return memoryJson(memories.decide(id, approved));
  });

  app.delete("/api/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    memories.delete(id);
    return reply.status(204).send();
  });
}
