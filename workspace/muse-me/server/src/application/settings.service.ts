import type { SecretRefStore } from "../domain/ports.js";

export interface ConnectionRow {
  name: string;
  status: string;
  detail: string;
}

export interface SettingsDeps {
  /** 模型名（控制面固定为确定性模拟口径时为 "mock"）。 */
  modelName: string;
  /** 运行时健康（RuntimePort.health）。 */
  runtimeHealth: () => Promise<Record<string, unknown>>;
  /** 运行时展示名（如「本地运行时」）。 */
  runtimeLabel: string;
  runtimeDetail: string;
  /** AgentCore 管理面健康；组合根恒注入（同 Python bootstrap 恒传 agentcore 对象）。 */
  agentcoreHealth: () => Promise<Record<string, unknown>>;
  secrets: SecretRefStore;
  userId: string;
}

/**
 * 账号与连接（同 Python SettingsService）：只读清单，只报状态与引用名，
 * 永不回显密钥明文。
 */
export class SettingsService {
  constructor(private readonly deps: SettingsDeps) {}

  async connections(): Promise<ConnectionRow[]> {
    const rows: ConnectionRow[] = [];
    if (this.deps.modelName === "openrouter") {
      rows.push({
        name: "模型通道",
        status: "OpenRouter（已配置）",
        detail: "密钥经环境变量 OPENROUTER_API_KEY 引用，不落库、不回显",
      });
    } else {
      rows.push({
        name: "模型通道",
        status: "Mock 模拟模型（离线）",
        detail: "设置 MUSE_ME_MODEL=openrouter 且提供 key 后切换真实模型",
      });
    }
    const health = await this.deps.runtimeHealth();
    rows.push({
      name: "Agent 运行时",
      status: `${this.deps.runtimeLabel} ${String(health.status ?? "ok")}`,
      detail: this.deps.runtimeDetail,
    });
    const ac = await this.deps.agentcoreHealth();
    rows.push({
      name: "AWS AgentCore",
      status: String(ac.status ?? ""),
      detail: String(ac.hint ?? "").slice(0, 120),
    });
    const refs = this.deps.secrets.listSecretRefs(this.deps.userId);
    if (refs.length > 0) {
      rows.push({
        name: "密钥库",
        status: `已登记 ${refs.length} 个引用`,
        detail: `引用名：${refs.map((r) => r.name).join("、")}（只存引用，不存明文）`,
      });
    } else {
      rows.push({
        name: "密钥库",
        status: "暂无登记引用",
        detail: "密钥只存引用名，明文永不进对话与日志",
      });
    }
    return rows;
  }
}
