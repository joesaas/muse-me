import type { FastifyInstance } from "fastify";
import { ValidationFailed } from "../domain/errors.js";
import type { AuthService } from "../application/auth.service.js";

/** 请求体取用：非对象一律当 {}（与 Python _body 同口径，不让下游 .get 炸）。 */
export function bodyOf(request: { body: unknown }): Record<string, unknown> {
  return request.body && typeof request.body === "object"
    ? (request.body as Record<string, unknown>)
    : {};
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post("/api/login", async (request, reply) => {
    const body = bodyOf(request);
    const token = auth.login(String(body.password ?? ""));
    if (!token) {
      return reply.status(401).send({ error: "口令不对" });
    }
    // 与 Python 版一致的 cookie：muse_session=<token>; HttpOnly; Path=/
    reply.header("Set-Cookie", `muse_session=${token}; HttpOnly; Path=/`);
    return { ok: true };
  });
}

export { ValidationFailed };
