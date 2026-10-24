/** 配置层：env 解析与校验。未知/非法值直接报错，不静默降级（评审定版口径）。 */

export interface AgentCoreConfig {
  /** AWS region；空串表示未配置。 */
  region: string;
  /** 已部署的 AgentCore Runtime ARN；空串表示未配置。 */
  runtimeArn: string;
}

export type RuntimeMode = "local" | "agentcore";

export interface ServerConfig {
  host: string;
  port: number;
  /** 登录口令（单用户 Demo 级别）。 */
  password: string;
  /** SQLite 文件路径（相对启动 cwd），或 ":memory:"。 */
  dbPath: string;
  userId: string;
  runtimeMode: RuntimeMode;
  agentcore: AgentCoreConfig;
}

export const DEFAULT_PASSWORD = "demo";

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SERVER_PORT 非法：${raw}（须为 1-65535 的整数）`);
  }
  return port;
}

function parseRuntimeMode(raw: string | undefined): RuntimeMode {
  if (raw === undefined || raw.trim() === "") return "local";
  if (raw === "local" || raw === "agentcore") return raw;
  throw new Error(`SERVER_RUNTIME 非法：${raw}（只允许 local | agentcore）`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.SERVER_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.SERVER_PORT),
    password: env.SERVER_PASSWORD ?? DEFAULT_PASSWORD,
    dbPath: env.SERVER_DB?.trim() || "data/server.db",
    userId: env.SERVER_USER_ID?.trim() || "demo-user",
    runtimeMode: parseRuntimeMode(env.SERVER_RUNTIME),
    agentcore: {
      region: (env.AGENTCORE_REGION || env.AWS_REGION || "").trim(),
      runtimeArn: (env.AGENTCORE_RUNTIME_ARN || "").trim(),
    },
  };
}

/** 测试与组合根可用的配置构造：以 loadConfig 默认值为基线做局部覆盖。 */
export function makeConfig(
  overrides: Partial<ServerConfig> = {},
  env: NodeJS.ProcessEnv = {},
): ServerConfig {
  return { ...loadConfig(env), ...overrides };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * 启动守卫（口径对齐 Python __main__）：监听非回环地址却仍用默认口令 demo
 * 时拒绝启动——默认口令只许本地用。
 */
export function assertSafeToStart(config: ServerConfig): void {
  if (!isLoopbackHost(config.host) && config.password === DEFAULT_PASSWORD) {
    throw new Error(
      `拒绝启动：监听地址 ${config.host} 不是本机回环，但登录口令仍是默认 demo。` +
        "请先设置环境变量 SERVER_PASSWORD 为自定义口令，或改绑 127.0.0.1 仅本地使用。",
    );
  }
}
