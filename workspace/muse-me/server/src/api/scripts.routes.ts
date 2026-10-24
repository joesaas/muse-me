import type { FastifyInstance } from "fastify";
import type { ChatService } from "../application/chat.service.js";
import type { ScriptService } from "../application/script.service.js";
import type { ChatStore, FeedStore } from "../domain/ports.js";
import { bodyOf } from "./auth.routes.js";
import { scriptJson } from "./serializers.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 脚本薄控制器：列表/详情/草稿构建/试运行/正式运行（同 Python api.py 口径）。 */
export function registerScriptRoutes(
  app: FastifyInstance,
  scripts: ScriptService,
  chats: ChatService,
  chatStore: ChatStore,
  feedStore: FeedStore,
): void {
  app.get("/api/scripts", async () => scripts.list().map(scriptJson));

  // 拼 intent 构建草稿：chat_id 给定时 intent 缺省取该话题最后一条 user 消息，
  // feed 上下文取话题绑定的条目；feed_item_id 给定时覆盖条目（同 Python /scripts/build）。
  app.post("/api/scripts/build", async (request) => {
    const body = bodyOf(request);
    let intent = String(body.intent ?? "");
    let item = undefined;
    if (body.chat_id) {
      const chat = chats.getChat(String(body.chat_id));
      const users = chatStore
        .listMessages(chat.id)
        .filter((m) => m.role === "user");
      if (!intent) intent = users[users.length - 1]?.content ?? "";
      if (chat.feedItemId) item = feedStore.getFeedItem(chat.feedItemId);
    }
    if (body.feed_item_id) {
      item = feedStore.getFeedItem(String(body.feed_item_id));
    }
    return scripts.buildDraft(intent, item ?? null);
  });

  app.get("/api/scripts/:id", async (request) => {
    const { id } = request.params as { id: string };
    return scriptJson(scripts.get(id));
  });

  app.post("/api/scripts/:id/trial", async (request) => {
    const { id } = request.params as { id: string };
    const body = bodyOf(request);
    const params = isPlainObject(body.params) ? body.params : {};
    return scripts.trial(id, params);
  });

  app.post("/api/scripts/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    const body = bodyOf(request);
    const params = isPlainObject(body.params) ? body.params : {};
    return scripts.run(id, { params });
  });
}
