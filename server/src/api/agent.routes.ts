import type { FastifyInstance } from "fastify";
import type { AgentAdminService } from "../application/agent-admin.service.js";
import type {
  CreateRuntimeInput,
  UpdateRuntimeInput,
} from "../domain/ports.js";
import { bodyOf } from "./auth.routes.js";

/** 控制面护栏来源信息（组合根传入；不由 AgentAdminService 提供——
 *  该服务只管 AgentCore/运行时健康，与控制面政策文件无关）。 */
export interface GuardrailSourceInfo {
  source?: string;
  policyPath?: string;
}

/** AgentCore 管理薄控制器：健康 + Runtime 资源 CRUD，全部经 AgentAdminService。 */
export function registerAgentRoutes(
  app: FastifyInstance,
  agentAdmin: AgentAdminService,
  guardrail?: GuardrailSourceInfo,
): void {
  // /api/agent/health 在 AgentCore 健康之外合并控制面护栏来源：
  // source 如实取自 loadGuardrailPolicy（file 或 fail-closed，不伪装），
  // 未传入时不编造字段（组合根永远传入）。
  app.get("/api/agent/health", async () => ({
    ...(await agentAdmin.health()),
    ...(guardrail?.source !== undefined
      ? {
          guardrailSource: guardrail.source,
          guardrailPolicyPath: guardrail.policyPath ?? "",
        }
      : {}),
  }));

  app.get("/api/agent/runtimes", async () => agentAdmin.listRuntimes());

  app.get("/api/agent/runtimes/:id", async (request) => {
    const { id } = request.params as { id: string };
    return agentAdmin.getRuntime(id);
  });

  app.post("/api/agent/runtimes", async (request) => {
    const body = bodyOf(request);
    const input: CreateRuntimeInput = {
      name: String(body.name ?? ""),
      containerUri:
        typeof body.container_uri === "string" ? body.container_uri : undefined,
      roleArn: typeof body.role_arn === "string" ? body.role_arn : undefined,
      networkMode: body.network_mode === "VPC" ? "VPC" : "PUBLIC",
      description: typeof body.description === "string" ? body.description : undefined,
    };
    return agentAdmin.createRuntime(input);
  });

  app.put("/api/agent/runtimes/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = bodyOf(request);
    const input: UpdateRuntimeInput = {
      containerUri:
        typeof body.container_uri === "string" ? body.container_uri : undefined,
      roleArn: typeof body.role_arn === "string" ? body.role_arn : undefined,
      networkMode:
        body.network_mode === "VPC" ? "VPC" : body.network_mode === "PUBLIC" ? "PUBLIC" : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
    };
    return agentAdmin.updateRuntime(id, input);
  });

  app.delete("/api/agent/runtimes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await agentAdmin.deleteRuntime(id);
    return reply.status(204).send();
  });
}
