import type { FastifyInstance } from "fastify";
import type { AgentAdminService } from "../application/agent-admin.service.js";
import type { ApprovalService } from "../application/approval.service.js";
import type { AuthService } from "../application/auth.service.js";
import type { ChatService } from "../application/chat.service.js";
import type { FeedService } from "../application/feed.service.js";
import type { FileService } from "../application/file.service.js";
import type { JobService } from "../application/job.service.js";
import type { MemoryService } from "../application/memory.service.js";
import type { PromptService } from "../application/prompt.service.js";
import type { ScriptService } from "../application/script.service.js";
import type { SettingsService } from "../application/settings.service.js";
import type { ChatStore, FeedStore, RunStore, ScriptStore } from "../domain/ports.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { registerApprovalRoutes } from "./approvals.routes.js";
import { registerAuthRoutes } from "./auth.routes.js";
import { registerChatRoutes } from "./chats.routes.js";
import { registerFeedRoutes } from "./feed.routes.js";
import { registerFileRoutes } from "./files.routes.js";
import { registerJobRoutes } from "./jobs.routes.js";
import { registerMemoryRoutes } from "./memories.routes.js";
import { registerRunRoutes } from "./runs.routes.js";
import { registerScriptRoutes } from "./scripts.routes.js";
import { registerSettingsRoutes } from "./settings.routes.js";
import { registerEventRoutes } from "./sse.js";

export interface RouteDeps {
  auth: AuthService;
  chats: ChatService;
  approvals: ApprovalService;
  agentAdmin: AgentAdminService;
  feed: FeedService;
  prompts: PromptService;
  scripts: ScriptService;
  jobs: JobService;
  memories: MemoryService;
  files: FileService;
  settings: SettingsService;
  runStore: RunStore;
  chatStore: ChatStore;
  feedStore: FeedStore;
  scriptStore: ScriptStore;
  userId: string;
}

/** 路由汇总注册：一期链路（登录/聊天/审批/运行记录/事件流/AgentCore 管理）
 * + 二期全量（精选/提示词/脚本/定时任务/记忆/文件/设置）。 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, deps.auth);
  registerChatRoutes(app, deps.chats);
  registerApprovalRoutes(app, deps.approvals);
  registerRunRoutes(
    app,
    deps.runStore,
    deps.chatStore,
    deps.chats,
    deps.userId,
    deps.scriptStore,
  );
  registerEventRoutes(app, deps.runStore);
  registerAgentRoutes(app, deps.agentAdmin);
  registerFeedRoutes(app, deps.feed, deps.prompts);
  registerScriptRoutes(app, deps.scripts, deps.chats, deps.chatStore, deps.feedStore);
  registerJobRoutes(app, deps.jobs);
  registerMemoryRoutes(app, deps.memories);
  registerFileRoutes(app, deps.files);
  registerSettingsRoutes(app, deps.settings);
}
