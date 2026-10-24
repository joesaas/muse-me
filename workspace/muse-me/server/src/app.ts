import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { AgentAdminService } from "./application/agent-admin.service.js";
import { ApprovalService } from "./application/approval.service.js";
import { AuthService } from "./application/auth.service.js";
import { ChatService } from "./application/chat.service.js";
import { FeedService } from "./application/feed.service.js";
import { FileService } from "./application/file.service.js";
import { JobService } from "./application/job.service.js";
import { MemoryService } from "./application/memory.service.js";
import { PromptService } from "./application/prompt.service.js";
import { ScriptEngine } from "./application/script-engine.js";
import { ScriptService } from "./application/script.service.js";
import { seedIfEmpty } from "./application/seed.js";
import { SettingsService } from "./application/settings.service.js";
import { makeAuthGuard } from "./api/auth-guard.js";
import { registerRoutes } from "./api/routes.js";
import type { ServerConfig } from "./config.js";
import { AppError, ValidationFailed } from "./domain/errors.js";
import type { RuntimePort } from "./domain/ports.js";
import { DEFAULT_GUARDRAIL_POLICY } from "./domain/types.js";
import { AgentCoreAdmin } from "./infrastructure/agentcore/agentcore-admin.js";
import { InMemorySessionStore } from "./infrastructure/auth/in-memory-session-store.js";
import { AgentCoreRuntime } from "./infrastructure/runtime/agentcore-runtime.js";
import { LocalRuntime } from "./infrastructure/runtime/local-runtime.js";
import { completeReply } from "./infrastructure/runtime/simulated.js";
import { SchedulerDaemon } from "./infrastructure/scheduler/scheduler-daemon.js";
import { nowIso, openDatabase } from "./infrastructure/sqlite/database.js";
import { SqliteApprovalStore } from "./infrastructure/sqlite/approvals.store.js";
import { SqliteChatStore } from "./infrastructure/sqlite/chats.store.js";
import { SqliteFeedStore } from "./infrastructure/sqlite/feed.store.js";
import { SqliteFileStore } from "./infrastructure/sqlite/files.store.js";
import { SqliteJobStore } from "./infrastructure/sqlite/jobs.store.js";
import { SqliteMemoryStore } from "./infrastructure/sqlite/memories.store.js";
import { SqliteNotificationStore } from "./infrastructure/sqlite/notifications.store.js";
import { SqlitePromptStore } from "./infrastructure/sqlite/prompts.store.js";
import { SqliteRunStore } from "./infrastructure/sqlite/runs.store.js";
import { SqliteScriptStore } from "./infrastructure/sqlite/scripts.store.js";
import { SqliteSecretRefStore } from "./infrastructure/sqlite/secrets.store.js";
import { SqliteRunSnapshotStore } from "./infrastructure/sqlite/snapshots.store.js";
import { DEFAULT_NEWS_POOL, SeedNewsSource } from "./infrastructure/tools/seed-news.js";
import { SimulatedToolRegistry } from "./infrastructure/tools/simulated-tools.js";

export interface BuiltApp {
  app: FastifyInstance;
  config: ServerConfig;
  runtime: RuntimePort;
  scheduler: SchedulerDaemon;
  close: () => Promise<void>;
}

/**
 * 前端静态根解析：显式配置（SERVER_WEB_ROOT）优先；否则从本文件向上找到
 * server 包根（package.json 所在目录），取其同级 ../web（仓库根 web/，
 * 即 frontend 构建产物目录）。目录不存在时返回 undefined（不托管静态，
 * API 照常工作——测试与纯 API 场景）。
 */
function resolveWebRoot(configured: string): string | undefined {
  if (configured) {
    const root = path.resolve(configured);
    return existsSync(path.join(root, "index.html")) ? root : undefined;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(path.join(dir, "package.json"))) {
      const candidate = path.resolve(dir, "..", "web");
      return existsSync(path.join(candidate, "index.html")) ? candidate : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 组合根（唯一让具体类相遇的地方）：构造 store -> 工具/运行时 -> 引擎/服务
 * -> 调度守护 -> 种子与精选首刷 -> Fastify 实例并装配守卫/路由/静态托管/错误映射。
 * main.ts 只做读配置与 listen。
 */
export function buildApp(config: ServerConfig): BuiltApp {
  const db = openDatabase(config.dbPath);
  const chatStore = new SqliteChatStore(db);
  const runStore = new SqliteRunStore(db);
  const approvalStore = new SqliteApprovalStore(db);
  const sessionStore = new InMemorySessionStore();
  const feedStore = new SqliteFeedStore(db);
  const promptStore = new SqlitePromptStore(db);
  const scriptStore = new SqliteScriptStore(db);
  const jobStore = new SqliteJobStore(db);
  const memoryStore = new SqliteMemoryStore(db);
  const fileStore = new SqliteFileStore(db);
  const notificationStore = new SqliteNotificationStore(db);
  const secretRefStore = new SqliteSecretRefStore(db);
  const snapshotStore = new SqliteRunSnapshotStore(db);

  const newsSource = new SeedNewsSource();
  // 工具注册表与精选共用同一新闻池；notify.send 的投递落站内通知（同 Python notify_sink）。
  const toolRegistry = new SimulatedToolRegistry(DEFAULT_NEWS_POOL, (note) => {
    notificationStore.addNotification({
      id: randomUUID(),
      userId: config.userId,
      kind: note.kind,
      title: note.title,
      body: note.body,
      read: false,
      createdAt: nowIso(),
    });
  });

  const runtime: RuntimePort =
    config.runtimeMode === "agentcore"
      ? new AgentCoreRuntime(config.agentcore, runStore)
      : new LocalRuntime(runStore, snapshotStore);
  const agentAdmin = new AgentCoreAdmin(config.agentcore);

  const auth = new AuthService(config.password, config.userId, sessionStore);
  const feedService = new FeedService(feedStore, promptStore, newsSource, config.userId);
  const promptService = new PromptService(promptStore, feedService, config.userId);
  const scriptEngine = new ScriptEngine(
    runStore,
    approvalStore,
    scriptStore,
    feedStore,
    toolRegistry,
    DEFAULT_GUARDRAIL_POLICY,
    config.userId,
  );
  const scriptService = new ScriptService(
    scriptEngine,
    scriptStore,
    feedStore,
    config.userId,
  );
  const chatService = new ChatService(
    chatStore,
    runStore,
    approvalStore,
    runtime,
    config.userId,
    completeReply,
    feedStore,
    scriptService,
  );
  const approvalService = new ApprovalService(
    approvalStore,
    runStore,
    chatService,
    config.userId,
    scriptService,
  );
  const jobService = new JobService(jobStore, scriptStore, config.userId);
  const memoryService = new MemoryService(memoryStore, config.userId);
  const fileService = new FileService(fileStore, scriptStore, config.userId);
  const settingsService = new SettingsService({
    modelName: "mock",
    runtimeHealth: () => runtime.health(),
    runtimeLabel: config.runtimeMode === "agentcore" ? "AgentCore 运行时" : "本地运行时",
    runtimeDetail:
      config.runtimeMode === "agentcore"
        ? "经 RuntimePort 适配 AWS AgentCore，轨迹全量落库可回放"
        : "进程内 LocalRuntime，轨迹全量落库可回放",
    agentcoreHealth: () => agentAdmin.health(),
    secrets: secretRefStore,
    userId: config.userId,
  });
  const agentAdminService = new AgentAdminService(
    agentAdmin,
    runtime,
    config.runtimeMode,
  );

  const scheduler = new SchedulerDaemon({
    jobs: jobStore,
    scripts: scriptStore,
    feed: feedStore,
    notifications: notificationStore,
    tools: toolRegistry,
    userId: config.userId,
    runner: (job, params, entity) => {
      const result = scriptService.run(job.scriptId, {
        params,
        source: "job",
        jobId: job.id,
        entity,
        version: job.scriptVersion,
      });
      return { runId: result.run_id, status: result.status, error: result.error };
    },
  });

  // 种子（幂等总闸：已有脚本整批跳过）+ 精选首刷（同 Python bootstrap 口径）。
  seedIfEmpty(
    {
      chats: chatStore,
      prompts: promptStore,
      scripts: scriptStore,
      files: fileStore,
      jobs: jobStore,
      memories: memoryStore,
    },
    config.userId,
  );
  if (feedStore.listFeedItems(config.userId, 1).length === 0) {
    feedService.refresh();
  }

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

  // 未匹配路由的 404 形状对齐 Python（{"error": "not found"}）。
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: "not found" });
  });

  registerRoutes(app, {
    auth,
    chats: chatService,
    approvals: approvalService,
    agentAdmin: agentAdminService,
    feed: feedService,
    prompts: promptService,
    scripts: scriptService,
    jobs: jobService,
    memories: memoryService,
    files: fileService,
    settings: settingsService,
    runStore,
    chatStore,
    feedStore,
    scriptStore,
    userId: config.userId,
  });

  // 前端同源托管：/api/* 是静态段路由，优先级高于静态通配，互不干扰。
  const webRoot = resolveWebRoot(config.webRoot);
  if (webRoot) {
    void app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  }

  if (config.startScheduler) scheduler.start();

  return {
    app,
    config,
    runtime,
    scheduler,
    close: async () => {
      scheduler.stop();
      await app.close();
      db.close();
    },
  };
}
