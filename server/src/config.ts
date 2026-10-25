/** 配置层：env 解析与校验。未知/非法值直接报错，不静默降级（评审定版口径）。 */

export interface AgentCoreConfig {
  /** AWS region；空串表示未配置。 */
  region: string;
  /** 已部署的 AgentCore Runtime ARN；空串表示未配置。 */
  runtimeArn: string;
}

export type RuntimeMode = "local" | "agentcore";

/**
 * OKX 交易所连接配置（只存引用：密钥来自环境变量，永不进仓库与日志）。
 * 模拟盘是默认且唯一的非显式放行路径：demo=true 时所有请求带
 * x-simulated-trading: 1（OKX 模拟盘用独立的模拟盘 API Key，在模拟盘
 * 环境内创建，不可拿实盘 Key + header 混用）；demo=false 且未显式
 * OKX_ALLOW_LIVE=true 时，交易工具直接拒绝（fail-closed，防误触实盘）。
 */
export interface OkxConfig {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  /** 模拟盘（默认 true）。 */
  demo: boolean;
  /** 显式放行实盘（默认 false）。 */
  allowLive: boolean;
  baseUrl: string;
}

export function parseFlag(raw: string | undefined, name: string, def: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return def;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new Error(`${name} 非法：${raw}（只允许 1/0/true/false）`);
}

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
  /** 前端静态根（SERVER_WEB_ROOT）；空串表示组合根按默认位置（仓库根 web/）解析。 */
  webRoot: string;
  /** 护栏文件根（MUSE_ME_HARNESS_ROOT）；空串表示自动向上查找 harness/。 */
  harnessRoot: string;
  /** 是否启动进程内调度守护（SERVER_SCHEDULER=0 关闭）。 */
  startScheduler: boolean;
  /** OKX 交易所连接（见 OkxConfig；三件套为空即未配置）。 */
  okx: OkxConfig;
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
    webRoot: env.SERVER_WEB_ROOT?.trim() || "",
    harnessRoot: env.MUSE_ME_HARNESS_ROOT?.trim() || "",
    startScheduler: env.SERVER_SCHEDULER?.trim() !== "0",
    okx: {
      apiKey: env.OKX_API_KEY?.trim() || "",
      apiSecret: env.OKX_API_SECRET?.trim() || "",
      passphrase: env.OKX_API_PASSPHRASE?.trim() || "",
      demo: parseFlag(env.OKX_DEMO, "OKX_DEMO", true),
      allowLive: parseFlag(env.OKX_ALLOW_LIVE, "OKX_ALLOW_LIVE", false),
      baseUrl: env.OKX_BASE_URL?.trim() || "https://www.okx.com",
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
