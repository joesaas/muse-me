import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand,
  UpdateAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { AgentCoreConfig } from "../../config.js";
import { RuntimeNotConfigured, ValidationFailed } from "../../domain/errors.js";
import type {
  AgentCorePort,
  AgentRuntimeSummary,
  CreateRuntimeInput,
  UpdateRuntimeInput,
} from "../../domain/ports.js";
import { AGENTCORE_CONFIG_HINT } from "../runtime/agentcore-runtime.js";

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose {
  return value && typeof value === "object" ? (value as Loose) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

/** 把控制面 API 的 Runtime 形状映射为端口摘要（防御式读取，不假设可选字段存在）。 */
function toSummary(raw: unknown): AgentRuntimeSummary {
  const rec = asRecord(raw);
  const artifact = asRecord(rec.agentRuntimeArtifact);
  const container = asRecord(artifact.containerConfiguration);
  return {
    id: str(rec.agentRuntimeId) ?? "",
    arn: str(rec.agentRuntimeArn),
    name: str(rec.agentRuntimeName) ?? "",
    version: str(rec.agentRuntimeVersion),
    status: str(rec.status),
    createdAt: iso(rec.createdAt),
    updatedAt: iso(rec.lastUpdatedAt),
    ...(str(container.containerUri) ? { containerUri: str(container.containerUri) } : {}),
    ...(str(rec.roleArn) ? { roleArn: str(rec.roleArn) } : {}),
  } as AgentRuntimeSummary;
}

/**
 * AgentCorePort 实现：封装 @aws-sdk/client-bedrock-agentcore-control 的
 * Runtime 资源管理（List/Get/Create/Update/Delete）。未配置 region 时
 * health 报告 not_configured、各方法抛 RuntimeNotConfigured，不伪装可用。
 * 本期未做真实 AWS 联调（无账号配置），按 SDK 契约编写。
 */
export class AgentCoreAdmin implements AgentCorePort {
  private client: BedrockAgentCoreControlClient | undefined;

  constructor(private readonly config: AgentCoreConfig) {}

  get configured(): boolean {
    return Boolean(this.config.region);
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new RuntimeNotConfigured("AgentCore 管理面未配置。" + AGENTCORE_CONFIG_HINT);
    }
  }

  private getClient(): BedrockAgentCoreControlClient {
    this.client ??= new BedrockAgentCoreControlClient({ region: this.config.region });
    return this.client;
  }

  async health(): Promise<Record<string, unknown>> {
    if (!this.configured) {
      return {
        status: "not_configured",
        plane: "agentcore-control",
        region: null,
        hint: AGENTCORE_CONFIG_HINT,
      };
    }
    return {
      status: "ok",
      plane: "agentcore-control",
      region: this.config.region,
      transport: "@aws-sdk/client-bedrock-agentcore-control",
      note: "资源管理已实现 SDK 封装；本期未做真实 AWS 联调。",
    };
  }

  async listRuntimes(): Promise<AgentRuntimeSummary[]> {
    this.requireConfigured();
    const out = await this.getClient().send(
      new ListAgentRuntimesCommand({ maxResults: 50 }),
    );
    return (out.agentRuntimes ?? []).map(toSummary);
  }

  async getRuntime(id: string): Promise<AgentRuntimeSummary> {
    this.requireConfigured();
    const out = await this.getClient().send(
      new GetAgentRuntimeCommand({ agentRuntimeId: id }),
    );
    // GetAgentRuntime 的响应是扁平结构（字段直接在顶层），toSummary 防御式读取。
    return toSummary(out);
  }

  async createRuntime(input: CreateRuntimeInput): Promise<AgentRuntimeSummary> {
    this.requireConfigured();
    if (!input.name?.trim()) throw new ValidationFailed("创建 Runtime 需要 name");
    if (!input.containerUri) {
      throw new ValidationFailed("创建 Runtime 需要 containerUri（容器镜像部署口径）");
    }
    if (!input.roleArn) {
      throw new ValidationFailed("创建 Runtime 需要 roleArn（执行角色）");
    }
    const out = await this.getClient().send(
      new CreateAgentRuntimeCommand({
        agentRuntimeName: input.name,
        description: input.description,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: input.containerUri },
        },
        networkConfiguration: { networkMode: input.networkMode ?? "PUBLIC" },
        roleArn: input.roleArn,
      }),
    );
    const rec = asRecord(out);
    return {
      id: str(rec.agentRuntimeId) ?? deriveIdFromArn(str(rec.agentRuntimeArn)),
      arn: str(rec.agentRuntimeArn),
      name: input.name,
      version: str(rec.agentRuntimeVersion),
      status: str(rec.status),
      createdAt: iso(rec.createdAt),
    };
  }

  async updateRuntime(
    id: string,
    input: UpdateRuntimeInput,
  ): Promise<AgentRuntimeSummary> {
    this.requireConfigured();
    // Update 接口要求 artifact/network/role 全量：先读现状再合并本侧改动。
    const current = await this.getRuntime(id);
    const currentRec = current as AgentRuntimeSummary & {
      containerUri?: string;
      roleArn?: string;
    };
    const containerUri = input.containerUri ?? currentRec.containerUri;
    const roleArn = input.roleArn ?? currentRec.roleArn;
    if (!containerUri || !roleArn) {
      throw new ValidationFailed(
        "更新 Runtime 需要 containerUri 与 roleArn（现状读取不到时须显式提供）",
      );
    }
    const out = await this.getClient().send(
      new UpdateAgentRuntimeCommand({
        agentRuntimeId: id,
        description: input.description,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri },
        },
        networkConfiguration: { networkMode: input.networkMode ?? "PUBLIC" },
        roleArn,
      }),
    );
    const rec = asRecord(out);
    return {
      ...current,
      arn: str(rec.agentRuntimeArn) ?? current.arn,
      version: str(rec.agentRuntimeVersion) ?? current.version,
      status: str(rec.status) ?? current.status,
      updatedAt: iso(rec.lastUpdatedAt) ?? current.updatedAt,
    };
  }

  async deleteRuntime(id: string): Promise<void> {
    this.requireConfigured();
    await this.getClient().send(new DeleteAgentRuntimeCommand({ agentRuntimeId: id }));
  }
}

function deriveIdFromArn(arn: string | undefined): string {
  if (!arn) return "";
  const parts = arn.split("/");
  return parts[parts.length - 1] ?? "";
}
