import type { FastifyInstance } from "fastify";
import type { ChatService } from "../application/chat.service.js";
import { bodyOf } from "./auth.routes.js";
import { chatJson, messageJson } from "./serializers.js";

/** 聊天薄控制器：只做入参解析/调 service/序列化，不写业务。 */
export function registerChatRoutes(app: FastifyInstance, chats: ChatService): void {
  app.get("/api/chats", async () => chats.listChats().map(chatJson));

  app.post("/api/chats", async (request) => {
    const body = bodyOf(request);
    const chat = chats.createChat({
      title: typeof body.title === "string" ? body.title : "",
      kind: typeof body.kind === "string" ? body.kind : "main",
      feedItemId:
        typeof body.feed_item_id === "string" ? body.feed_item_id : null,
      scene: typeof body.scene === "string" ? body.scene : undefined,
    });
    return chatJson(chat);
  });

  app.get("/api/chats/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    return chats.listMessages(id).map(messageJson);
  });

  app.post("/api/chats/:id/send", async (request) => {
    const { id } = request.params as { id: string };
    const body = bodyOf(request);
    const result = await chats.send(id, String(body.text ?? ""));
    return { run_id: result.runId };
  });
}
