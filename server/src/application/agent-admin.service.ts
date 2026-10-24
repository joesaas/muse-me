import type {
  AgentCorePort,
  AgentRuntimeSummary,
  CreateRuntimeInput,
  RuntimePort,
  UpdateRuntimeInput,
} from "../domain/ports.js";

/**
 * AgentCore 管理用例：健康与 Runtime 资源管理，全部经端口（AgentCorePort /
 * RuntimePort），本层不直接碰 AWS SDK。
 */
export class AgentAdminService {
  constructor(
    private readonly admin: AgentCorePort,
    private readonly runtime: RuntimePort,
    private readonly runtimeMode: string,
  ) {}

  async health(): Promise<Record<string, unknown>> {
    return {
      runtimeMode: this.runtimeMode,
      runtime: await this.runtime.health(),
      agentcore: await this.admin.health(),
    };
  }

  listRuntimes(): Promise<AgentRuntimeSummary[]> {
    return this.admin.listRuntimes();
  }

  getRuntime(id: string): Promise<AgentRuntimeSummary> {
    return this.admin.getRuntime(id);
  }

  createRuntime(input: CreateRuntimeInput): Promise<AgentRuntimeSummary> {
    return this.admin.createRuntime(input);
  }

  updateRuntime(id: string, input: UpdateRuntimeInput): Promise<AgentRuntimeSummary> {
    return this.admin.updateRuntime(id, input);
  }

  deleteRuntime(id: string): Promise<void> {
    return this.admin.deleteRuntime(id);
  }
}
