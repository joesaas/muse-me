import type { FastifyInstance } from "fastify";
import type { AgentAdminService } from "../application/agent-admin.service.js";
import type { ApprovalService } from "../application/approval.service.js";
import type { AuthService } from "../application/auth.service.js";
import type { ChatService } from "../application/chat.service.js";
import type { ChatStore, RunStore } from "../domain/ports.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { registerApprovalRoutes } from "./approvals.routes.js";
import { registerAuthRoutes } from "./auth.routes.js";
import { registerChatRoutes } from "./chats.routes.js";
import { registerRunRoutes } from "./runs.routes.js";
import { registerEventRoutes } from "./sse.js";

export interface RouteDeps {
  auth: AuthService;
  chats: ChatService;
  approvals: ApprovalService;
  agentAdmin: AgentAdminService;
  runStore: RunStore;
  chatStore: ChatStore;
  userId: string;
}

/** 路由汇总注册：本期链路子集（登录/聊天/审批/运行记录/事件流/AgentCore 管理）。 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, deps.auth);
  registerChatRoutes(app, deps.chats);
  registerApprovalRoutes(app, deps.approvals);
  registerRunRoutes(app, deps.runStore, deps.chatStore, deps.chats, deps.userId);
  registerEventRoutes(app, deps.runStore);
  registerAgentRoutes(app, deps.agentAdmin);
}
