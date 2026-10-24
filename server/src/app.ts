import Fastify, { type FastifyInstance } from "fastify";
import { AgentAdminService } from "./application/agent-admin.service.js";
import { ApprovalService } from "./application/approval.service.js";
import { AuthService } from "./application/auth.service.js";
import { ChatService } from "./application/chat.service.js";
import { makeAuthGuard } from "./api/auth-guard.js";
import { registerRoutes } from "./api/routes.js";
import type { ServerConfig } from "./config.js";
import { AppError, ValidationFailed } from "./domain/errors.js";
import type { RuntimePort } from "./domain/ports.js";
import { AgentCoreAdmin } from "./infrastructure/agentcore/agentcore-admin.js";
import { InMemorySessionStore } from "./infrastructure/auth/in-memory-session-store.js";
import { AgentCoreRuntime } from "./infrastructure/runtime/agentcore-runtime.js";
import { LocalRuntime } from "./infrastructure/runtime/local-runtime.js";
import { completeReply } from "./infrastructure/runtime/simulated.js";
import { openDatabase } from "./infrastructure/sqlite/database.js";
import { SqliteApprovalStore } from "./infrastructure/sqlite/approvals.store.js";
import { SqliteChatStore } from "./infrastructure/sqlite/chats.store.js";
import { SqliteRunStore } from "./infrastructure/sqlite/runs.store.js";

export interface BuiltApp {
  app: FastifyInstance;
  config: ServerConfig;
  runtime: RuntimePort;
  close: () => Promise<void>;
}

/**
 * 组合根（唯一让具体类相遇的地方）：构造 store -> runtime -> services ->
 * Fastify 实例并装配守卫/路由/错误映射。main.ts 只做读配置与 listen。
 */
export function buildApp(config: ServerConfig): BuiltApp {
  const db = openDatabase(config.dbPath);
  const chatStore = new SqliteChatStore(db);
  const runStore = new SqliteRunStore(db);
  const approvalStore = new SqliteApprovalStore(db);
  const sessionStore = new InMemorySessionStore();

  const runtime: RuntimePort =
    config.runtimeMode === "agentcore"
      ? new AgentCoreRuntime(config.agentcore, runStore)
      : new LocalRuntime(runStore);
  const agentAdmin = new AgentCoreAdmin(config.agentcore);

  const auth = new AuthService(config.password, config.userId, sessionStore);
  const chatService = new ChatService(
    chatStore,
    runStore,
    approvalStore,
    runtime,
    config.userId,
    completeReply,
  );
  const approvalService = new ApprovalService(
    approvalStore,
    runStore,
    chatService,
    config.userId,
  );
  const agentAdminService = new AgentAdminService(
    agentAdmin,
    runtime,
    config.runtimeMode,
  );

  const app = Fastify({ logger: false });

  // 请求体口径对齐 Python _body：空体当 {}，非法 JSON 抛 ValidationFailed(400)。
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = typeof body === "string" ? body : "";
      if (!text.trim()) return done(null, {});
      try {
        done(null, JSON.parse(text) as unknown);
      } catch {
        done(new ValidationFailed("请求体不是合法 JSON"), undefined);
      }
    },
  );

  app.addHook("preHandler", makeAuthGuard(auth));

  // 错误映射唯一收口：AppError 按 httpStatus，其余 500 且不漏内部原文。
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.httpStatus).send({ error: error.message });
    }
    request.log.error(error);
    return reply.status(500).send({ error: "internal error" });
  });

  registerRoutes(app, {
    auth,
    chats: chatService,
    approvals: approvalService,
    agentAdmin: agentAdminService,
    runStore,
    chatStore,
    userId: config.userId,
  });

  return {
    app,
    config,
    runtime,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
