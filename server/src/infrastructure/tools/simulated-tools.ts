import { createHash } from "node:crypto";
import { GuardrailDenied, NotFound } from "../../domain/errors.js";
import { extractToken } from "../../domain/extract.js";
import type { ToolRegistryPort } from "../../domain/ports.js";
import {
  AAVE_RATES,
  KNOWN_PRICES,
  STABLECOINS,
  TOOL_DEFS,
  type ToolDef,
} from "../../domain/tool-catalog.js";
import type { RawNewsItem } from "../../domain/types.js";

/**
 * ToolRegistryPort 的确定性模拟实现（移植 Python tools.py）：
 * 已知标的用内置价格表，其余按符号 sha256 哈希生成稳定伪价格；
 * 同一输入永远同一输出（无随机、无网络）。写工具在 mode="live" 一律
 * GuardrailDenied（Demo 不动真实资产）。结果带 source: "simulated"
 * （news.search 与 Python 一致不带）与 cost_usd 供引擎计费。
 */

function hashInt(text: string): number {
  return Number.parseInt(
    createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12),
    16,
  );
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Python str(float) 口径：整数值浮点渲染为 "100.0"（sim_tx 哈希种子用）。 */
function pyFloatStr(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function pseudoPrice(symbol: string): number {
  const h = hashInt(`price:${symbol.toUpperCase()}`);
  return roundTo(0.0001 + (h % 500_000) / 10_000.0, 8);
}

export function priceOf(symbol: string): number {
  const upper = symbol.toUpperCase();
  return KNOWN_PRICES[upper] ?? pseudoPrice(upper);
}

export function liquidityOf(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (STABLECOINS.has(upper)) return 500_000_000.0;
  if (upper === "BTC" || upper === "ETH") return 250_000_000.0;
  if (upper in KNOWN_PRICES) return 2_000_000 + (hashInt(`liq:${upper}`) % 18_000_000);
  return 5_000 + (hashInt(`liq:${upper}`) % 95_000);
}

export interface NotifyNote {
  title: string;
  body: string;
  kind: string;
}

export class SimulatedToolRegistry implements ToolRegistryPort {
  /** 无 notify 回调时的本地投递箱（同 Python outbox）。 */
  readonly outbox: NotifyNote[] = [];

  constructor(
    private readonly newsPool: RawNewsItem[],
    private readonly notifySink?: (note: NotifyNote) => void,
  ) {}

  hasTool(name: string): boolean {
    return TOOL_DEFS.has(name);
  }

  getTool(name: string): ToolDef | undefined {
    return TOOL_DEFS.get(name);
  }

  call(
    name: string,
    args: Record<string, unknown> = {},
    mode = "simulate",
  ): Record<string, unknown> {
    if (!TOOL_DEFS.has(name)) throw new NotFound(`工具不在白名单：${name}`);
    const a = { ...args };
    switch (name) {
      case "market.quote":
        return this.marketQuote(a);
      case "meme.scan":
        return this.memeScan(a);
      case "dex.quote":
        return this.dexQuote(a);
      case "dex.sim_swap":
        return this.dexSimSwap(a, mode);
      case "aave.rates":
        return this.aaveRates(a);
      case "aave.sim_supply":
        return this.aaveSimSupply(a, mode);
      case "news.search":
        return this.newsSearch(a);
      case "web.fetch":
        return this.webFetch(a);
      case "notify.send":
        return this.notifySend(a, mode);
      default:
        throw new NotFound(`工具不在白名单：${name}`);
    }
  }

  // ---------------- 各工具实现（与 Python 逐项对齐） ----------------

  private marketQuote(args: Record<string, unknown>): Record<string, unknown> {
    const symbol = String(args.symbol ?? args.token ?? "").toUpperCase();
    if (!symbol) throw new GuardrailDenied("market.quote 缺少 symbol 参数");
    const change = roundTo((hashInt(`chg:${symbol}`) % 2000) / 100.0 - 10.0, 2);
    return {
      symbol,
      price_usd: priceOf(symbol),
      change_24h_pct: change,
      source: "simulated",
      cost_usd: 0.001,
    };
  }

  private memeScan(args: Record<string, unknown>): Record<string, unknown> {
    const token =
      String(args.token ?? "").toUpperCase() ||
      extractToken(String(args.text ?? args.news ?? ""));
    if (!token) throw new GuardrailDenied("meme.scan 无法从输入中抽取代币");
    const liquidity = liquidityOf(token);
    const holders = 200 + (hashInt(`risk:${token}`) % 50_000);
    const risk = liquidity >= 5_000_000 ? "low" : liquidity >= 500_000 ? "medium" : "high";
    const warnings: string[] = [];
    if (risk === "high") warnings.push("流动性不足 50 万美元，滑点与无法卖出风险高");
    if (!(token in KNOWN_PRICES)) warnings.push("非主流标的，价格为模拟估值，务必小额");
    return {
      token,
      price_usd: priceOf(token),
      liquidity_usd: liquidity,
      holders,
      risk_level: risk,
      warnings,
      source: "simulated",
      cost_usd: 0.002,
    };
  }

  private dexQuote(args: Record<string, unknown>): Record<string, unknown> {
    const token = String(args.token ?? args.symbol ?? "").toUpperCase();
    const amount = Number(args.amount_usd ?? 0);
    if (!token || !(amount > 0)) {
      throw new GuardrailDenied("dex.quote 需要 token 与正数 amount_usd");
    }
    const price = priceOf(token);
    const liquidity = liquidityOf(token);
    const slippagePct = roundTo(
      Math.min(15.0, (amount / Math.max(liquidity, 1.0)) * 100.0 + 0.1),
      3,
    );
    const effectivePrice = price * (1 - slippagePct / 100.0);
    return {
      token,
      amount_usd: amount,
      price_usd: price,
      effective_price_usd: roundTo(effectivePrice, 8),
      est_received: effectivePrice ? roundTo(amount / effectivePrice, 6) : 0,
      slippage_pct: slippagePct,
      fee_usd: roundTo(amount * 0.003, 4),
      source: "simulated",
      cost_usd: 0.002,
    };
  }

  private dexSimSwap(
    args: Record<string, unknown>,
    mode: string,
  ): Record<string, unknown> {
    if (mode === "live") {
      throw new GuardrailDenied("Demo 只做模拟成交，dex.sim_swap 不执行真实兑换");
    }
    const quote = this.dexQuote(args);
    const token = String(quote.token);
    const amount = Number(quote.amount_usd);
    return {
      status: "simulated",
      token,
      amount_usd: amount,
      received: quote.est_received,
      price_usd: quote.effective_price_usd,
      sim_tx:
        "SIM-" +
        createHash("sha256")
          .update(`swap:${token}:${pyFloatStr(amount)}`, "utf8")
          .digest("hex")
          .slice(0, 16),
      note: "模拟成交，未动真实资产",
      cost_usd: 0.003,
    };
  }

  private aaveRates(args: Record<string, unknown>): Record<string, unknown> {
    const asset = String(args.asset ?? "").toUpperCase();
    if (asset) {
      const rate = AAVE_RATES[asset];
      if (!rate) throw new NotFound(`Aave 未收录资产：${asset}`);
      return { asset, ...rate, source: "simulated", cost_usd: 0.001 };
    }
    return {
      assets: Object.keys(AAVE_RATES)
        .sort()
        .map((name) => ({ asset: name, ...AAVE_RATES[name]! })),
      source: "simulated",
      cost_usd: 0.001,
    };
  }

  private aaveSimSupply(
    args: Record<string, unknown>,
    mode: string,
  ): Record<string, unknown> {
    if (mode === "live") {
      throw new GuardrailDenied("Demo 只做模拟存入，aave.sim_supply 不动真实资产");
    }
    const asset = String(args.asset || "USDC").toUpperCase();
    const amount = Number(args.amount_usd || args.amount || 0);
    const rate = AAVE_RATES[asset];
    if (!rate) throw new NotFound(`Aave 未收录资产：${asset}`);
    if (!(amount > 0)) throw new GuardrailDenied("aave.sim_supply 需要正数金额");
    const days = Math.trunc(Number(args.days || 365));
    const earnings = roundTo(((amount * rate.supply_apy) / 100.0) * (days / 365.0), 4);
    return {
      status: "simulated",
      asset,
      amount_usd: amount,
      supply_apy: rate.supply_apy,
      days,
      est_earnings_usd: earnings,
      est_total_usd: roundTo(amount + earnings, 4),
      note: "模拟存入测算，未动真实资产",
      cost_usd: 0.002,
    };
  }

  private newsSearch(args: Record<string, unknown>): Record<string, unknown> {
    const query = String(args.query ?? args.keyword ?? "").toLowerCase();
    const limitRaw = Number(args.limit || 5);
    const limit = Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 5;
    const hits = this.newsPool.filter((item) => {
      const haystack =
        `${item.title ?? ""} ${item.summary ?? ""} ${item.topic ?? ""}`.toLowerCase();
      return !query || haystack.includes(query);
    });
    const page = hits.slice(0, limit).map((item) => ({ ...item }));
    return { query, count: page.length, items: page, cost_usd: 0.001 };
  }

  private webFetch(args: Record<string, unknown>): Record<string, unknown> {
    const url = String(args.url ?? "");
    if (!url) throw new GuardrailDenied("web.fetch 缺少 url 参数");
    return {
      url,
      status: "stub",
      title: "",
      summary: "（Demo 桩）web.fetch 未真实抓取，仅回占位摘要。",
      cost_usd: 0.0,
    };
  }

  private notifySend(
    args: Record<string, unknown>,
    mode: string,
  ): Record<string, unknown> {
    if (mode === "live") {
      throw new GuardrailDenied("Demo 的 notify.send 只写站内通知（simulate/local）");
    }
    const note: NotifyNote = {
      title: String(args.title || "通知"),
      body: String(args.body || ""),
      kind: String(args.kind || "info"),
    };
    let delivered: string;
    if (this.notifySink) {
      this.notifySink(note);
      delivered = "callback";
    } else {
      this.outbox.push(note);
      delivered = "local";
    }
    return { delivered, ...note, cost_usd: 0.0 };
  }
}
