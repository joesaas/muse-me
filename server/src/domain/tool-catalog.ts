/**
 * 工具目录数据（与 Python tools.py 的 _TOOL_DEFS / KNOWN_PRICES / AAVE_RATES 逐项一致）。
 * 这是领域数据表：风险级与 TOOL_RISKS 同源，参数 schema 供脚本引擎做数值化护栏。
 */

export interface ToolDef {
  name: string;
  risk: "read" | "write" | "irreversible";
  description: string;
  /** 参数名 -> 类型规格（"string" | "number"，尾 "?" 表示可选）。 */
  params: Readonly<Record<string, string>>;
}

export const TOOL_CATALOG: readonly ToolDef[] = [
  { name: "market.quote", risk: "read", description: "查询标的现价", params: { symbol: "string" } },
  {
    name: "meme.scan",
    risk: "read",
    description: "从新闻/代币抽实体并查流动性与风险",
    params: { token: "string?", text: "string?" },
  },
  {
    name: "dex.quote",
    risk: "read",
    description: "DEX 报价（预计成交价/滑点）",
    params: { token: "string", amount_usd: "number" },
  },
  {
    name: "dex.sim_swap",
    risk: "write",
    description: "模拟兑换（Demo 只模拟）",
    params: { token: "string", amount_usd: "number" },
  },
  { name: "aave.rates", risk: "read", description: "Aave 各资产利率", params: { asset: "string?" } },
  {
    name: "aave.sim_supply",
    risk: "write",
    description: "模拟存入并测算收益",
    params: { asset: "string", amount_usd: "number", days: "number?" },
  },
  { name: "news.search", risk: "read", description: "按关键词检索新闻池", params: { query: "string" } },
  {
    name: "web.fetch",
    risk: "read",
    description: "抓取网页（Demo 桩，返回摘要占位）",
    params: { url: "string" },
  },
  {
    name: "notify.send",
    risk: "write",
    description: "站内通知",
    params: { title: "string", body: "string" },
  },
  // ---- OKX 交易所（真实 API；执行环境由 OKX 配置定：默认模拟盘） ----
  {
    name: "okx.balance",
    risk: "read",
    description: "OKX 账户余额（模拟盘/实盘由配置定）",
    params: { ccy: "string?" },
  },
  {
    name: "okx.ticker",
    risk: "read",
    description: "OKX 行情现价（公开接口，无需密钥）",
    params: { inst_id: "string" },
  },
  {
    name: "okx.positions",
    risk: "read",
    description: "OKX 持仓（默认永续）",
    params: { inst_type: "string?" },
  },
  {
    name: "okx.order",
    risk: "read",
    description: "OKX 订单详情",
    params: { inst_id: "string", ord_id: "string" },
  },
  {
    name: "okx.spot_order",
    risk: "irreversible",
    description: "OKX 现货市价下单（买入按 USDT 金额，卖出按金额折算币量）",
    params: { inst_id: "string", side: "string", amount_usd: "number" },
  },
  {
    name: "okx.perp_order",
    risk: "irreversible",
    description: "OKX 永续市价开仓（做多/做空，金额折算张数）",
    params: { inst_id: "string", side: "string", amount_usd: "number" },
  },
];

export const TOOL_DEFS: ReadonlyMap<string, ToolDef> = new Map(
  TOOL_CATALOG.map((def) => [def.name, def]),
);

/** 已知标的价格表（模拟数据，仅 Demo 用；与 Python KNOWN_PRICES 一致）。 */
export const KNOWN_PRICES: Readonly<Record<string, number>> = {
  BTC: 97400.0,
  ETH: 3420.0,
  SOL: 214.5,
  USDC: 1.0,
  USDT: 1.0,
  DAI: 1.0,
  AAVE: 365.0,
  UNI: 13.8,
  DOGE: 0.32,
  WIF: 2.14,
  PEPE: 0.0000182,
  BONK: 0.0000321,
};

export const STABLECOINS: ReadonlySet<string> = new Set(["USDC", "USDT", "DAI"]);

export interface AaveRate {
  supply_apy: number;
  borrow_apy: number;
}

/** Aave 利率表（键序与 Python AAVE_RATES 一致，草稿 asset 选取按此顺序扫描）。 */
export const AAVE_RATES: Readonly<Record<string, AaveRate>> = {
  USDC: { supply_apy: 4.62, borrow_apy: 6.1 },
  USDT: { supply_apy: 4.35, borrow_apy: 5.88 },
  DAI: { supply_apy: 4.1, borrow_apy: 5.65 },
  ETH: { supply_apy: 2.85, borrow_apy: 3.4 },
  WBTC: { supply_apy: 1.92, borrow_apy: 2.55 },
  AAVE: { supply_apy: 0.0, borrow_apy: 4.2 },
};
