import type { ToolRegistryPort } from "../../domain/ports.js";

/**
 * 组合工具注册表（批次三「工具单实现」的延续）：模拟工具与真实 API
 * 工具各守自己的白名单，按名字前缀路由——okx.* 走真实客户端，
 * 其余走确定性模拟。目录（TOOL_DEFS）仍是唯一白名单数据源，
 * 两边 getTool 都查同一张表，不各自造表。
 */
export class CompositeToolRegistry implements ToolRegistryPort {
  constructor(
    private readonly simulated: ToolRegistryPort,
    private readonly okx: ToolRegistryPort,
  ) {}

  hasTool(name: string): boolean {
    return this.simulated.hasTool(name) || this.okx.hasTool(name);
  }

  getTool(
    name: string,
  ): { name: string; risk: string; params: Readonly<Record<string, string>> } | undefined {
    return this.simulated.getTool(name) ?? this.okx.getTool(name);
  }

  call(
    name: string,
    args: Record<string, unknown> = {},
    mode = "simulate",
  ): Promise<Record<string, unknown>> {
    if (name.startsWith("okx.")) return this.okx.call(name, args, mode);
    return this.simulated.call(name, args, mode);
  }
}
