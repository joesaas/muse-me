import type { FastifyInstance } from "fastify";
import type { FeedService } from "../application/feed.service.js";
import type { PromptService } from "../application/prompt.service.js";
import { bodyOf } from "./auth.routes.js";
import { feedJson } from "./serializers.js";

/** 精选与提示词薄控制器（同 Python api.py 的 feed/prompts 路由）。 */
export function registerFeedRoutes(
  app: FastifyInstance,
  feed: FeedService,
  prompts: PromptService,
): void {
  app.get("/api/feed", async () => feed.list().map(feedJson));

  app.post("/api/feed/refresh", async () => feed.refresh().map(feedJson));

  app.get("/api/prompts/feed", async () => prompts.getFeed());

  app.put("/api/prompts/feed", async (request) => {
    const body = bodyOf(request);
    return prompts.setFeed(String(body.content ?? ""));
  });

  app.get("/api/prompts/feed/versions", async () => prompts.versions());

  app.post("/api/prompts/feed/rollback", async (request) => {
    const body = bodyOf(request);
    // 同 Python int(body.get("version") or 0) 口径：数字/数字字符串可解析，
    // 其余按 0 处理（版本集里没有 0 → 404「版本不存在」）。
    const raw = body.version;
    const version =
      typeof raw === "number"
        ? Math.trunc(raw)
        : typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())
          ? Number.parseInt(raw.trim(), 10)
          : 0;
    return prompts.rollback(version);
  });
}
