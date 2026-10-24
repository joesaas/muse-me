import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../application/auth.service.js";

/** 从 Cookie 头解析 muse_session（与 Python 版一致的 cookie 名与口径）。 */
export function sessionTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "muse_session") return rest.join("=");
  }
  return undefined;
}

const PUBLIC_PATHS = new Set(["/api/login", "/health"]);

/**
 * 鉴权 preHandler：除登录与健康检查外，/api/* 一律要求有效 muse_session
 * cookie，无效 401（与 Python 版一致）。
 */
export function makeAuthGuard(auth: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (PUBLIC_PATHS.has(path) || !path.startsWith("/api/")) return;
    const userId = auth.authenticate(sessionTokenOf(request));
    if (!userId) {
      await reply.status(401).send({ error: "unauthorized" });
      return;
    }
    (request as FastifyRequest & { userId?: string }).userId = userId;
  };
}
