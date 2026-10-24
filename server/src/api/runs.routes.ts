import type { FastifyInstance } from "fastify";
import type { ChatService } from "../application/chat.service.js";
import { NotFound } from "../domain/errors.js";
import type { ChatStore, RunStore } from "../domain/ports.js";
import { runJson } from "./serializers.js";

/** 运行记录薄控制器：列表/详情（带事件回放）/取消。标题组装与 Python _run_json 同口径。 */
export function registerRunRoutes(
  app: FastifyInstance,
  runs: RunStore,
  chats: ChatStore,
  chatService: ChatService,
  userId: string,
): void {
  const titleOf = (run: { chatId: string | null; scene: string }): string => {
    if (run.chatId) return chats.getChat(run.chatId)?.title ?? run.scene;
    return run.scene;
  };

  app.get("/api/runs", async () =>
    runs.listRuns(userId).map((run) => runJson(run, titleOf(run))),
  );

  app.get("/api/runs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const run = runs.getRun(id);
    if (!run) throw new NotFound(`运行不存在：${id}`);
    return runJson(run, titleOf(run), runs.listEvents(id, 0));
  });

  app.post("/api/runs/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    const ok = await chatService.cancel(id);
    return { ok };
  });
}
