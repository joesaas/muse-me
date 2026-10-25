import { GuardrailDenied, NotFound } from "../../domain/errors.js";
import type { ToolRegistryPort } from "../../domain/ports.js";
import { TOOL_DEFS, type ToolDef } from "../../domain/tool-catalog.js";
import { OkxClient } from "./okx-client.js";

/**
 * OKX 工具注册表（ToolRegistryPort 的 okx.* 分支）：
 * 读工具（余额/行情/持仓/订单）任何模式都真实调用；下单工具分模式——
 * mode="simulate"（试运行）只出预览不下单，mode="execute"（正式运行）
 * 才真实下单，且执行环境由 OKX 配置定（默认模拟盘；实盘须显式放行，
 * 否则 assertTradable 拒绝）。mode="live" 一律拒绝（OKX 环境不由
 * 运行模式决定，避免语义混淆）。结果带 source: "okx" 与 environment，
 * 轨迹里一眼可辨是模拟盘还是实盘。
 */

const OKX_TOOLS = new Set([
  "okx.balance",
  "okx.ticker",
  "okx.positions",
  "okx.order",
  "okx.spot_order",
  "okx.perp_order",
]);

function num(value: unknown, name: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new GuardrailDenied(`okx 参数 ${name} 需要数字`);
  return n;
}

function str(value: unknown, name: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new GuardrailDenied(`okx 缺少参数：${name}`);
  return s;
}

/** 按 lotSz 精度向下取整（永续张数必须是 lotSz 的整数倍）。 */
export function floorToLot(contractsRaw: number, lotSz: string): number {
  const lot = Number(lotSz);
  if (!(lot > 0) || !(contractsRaw > 0)) return 0;
  const decimals = lotSz.includes(".") ? lotSz.split(".")[1]!.length : 0;
  return Number((Math.floor(contractsRaw / lot) * lot).toFixed(decimals));
}

export class OkxToolRegistry implements ToolRegistryPort {
  constructor(private readonly client: OkxClient) {}

  hasTool(name: string): boolean {
    return OKX_TOOLS.has(name);
  }

  getTool(name: string): ToolDef | undefined {
    return OKX_TOOLS.has(name) ? TOOL_DEFS.get(name) : undefined;
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    mode = "simulate",
  ): Promise<Record<string, unknown>> {
    if (!OKX_TOOLS.has(name)) throw new NotFound(`工具不在白名单：${name}`);
    const env = { source: "okx", environment: this.client.environment };
    switch (name) {
      case "okx.balance": {
        const ccy = String(args.ccy ?? "").trim() || undefined;
        const balances = await this.client.balance(ccy);
        return { ...env, balances, cost_usd: 0.001 };
      }
      case "okx.ticker": {
        const instId = str(args.inst_id, "inst_id");
        const tick = await this.client.ticker(instId);
        return { ...env, inst_id: tick.instId, price_usd: Number(tick.last), cost_usd: 0.001 };
      }
      case "okx.positions": {
        const instType = String(args.inst_type ?? "SWAP").trim() || "SWAP";
        const positions = await this.client.positions(instType);
        return { ...env, inst_type: instType, positions, cost_usd: 0.001 };
      }
      case "okx.order": {
        const instId = str(args.inst_id, "inst_id");
        const ordId = str(args.ord_id, "ord_id");
        const detail = await this.client.orderDetail(instId, ordId);
        return {
          ...env,
          inst_id: String(detail.instId ?? instId),
          ord_id: String(detail.ordId ?? ordId),
          state: String(detail.state ?? ""),
          side: String(detail.side ?? ""),
          px: String(detail.px ?? ""),
          sz: String(detail.sz ?? ""),
          acc_fill_sz: String(detail.accFillSz ?? ""),
          cost_usd: 0.001,
        };
      }
      case "okx.spot_order":
        return this.spotOrder(args, mode, env);
      case "okx.perp_order":
        return this.perpOrder(args, mode, env);
      default:
        throw new NotFound(`工具不在白名单：${name}`);
    }
  }

  /**
   * 现货市价下单。买入：sz 按 USDT 金额（tgtCcy=quote_ccy）；卖出：
   * 先取现价把金额折算成币量（tgtCcy=base_ccy）。试运行只出预览。
   */
  private async spotOrder(
    args: Record<string, unknown>,
    mode: string,
    env: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const instId = str(args.inst_id, "inst_id").toUpperCase();
    const sideRaw = str(args.side, "side").toLowerCase();
    if (sideRaw !== "buy" && sideRaw !== "sell") {
      throw new GuardrailDenied(`okx.spot_order 的 side 只允许 buy/sell，收到 ${sideRaw}`);
    }
    const amountUsd = num(args.amount_usd, "amount_usd");
    if (!(amountUsd > 0)) throw new GuardrailDenied("okx.spot_order 需要正数 amount_usd");
    let sz: string;
    let tgtCcy: string;
    if (sideRaw === "buy") {
      sz = String(amountUsd);
      tgtCcy = "quote_ccy";
    } else {
      const tick = await this.client.ticker(instId);
      const price = Number(tick.last);
      if (!(price > 0)) throw new GuardrailDenied(`okx 现价异常：${instId} = ${tick.last}`);
      sz = String(amountUsd / price);
      tgtCcy = "base_ccy";
    }
    if (mode === "simulate") {
      return {
        ...env,
        status: "preview",
        note: "试运行不下单：正式运行经审批后在 OKX 执行（默认模拟盘）",
        inst_id: instId,
        side: sideRaw,
        amount_usd: amountUsd,
        sz,
        tgt_ccy: tgtCcy,
        cost_usd: 0.001,
      };
    }
    if (mode !== "execute") {
      throw new GuardrailDenied(`okx.spot_order 不接受 mode=${mode}`);
    }
    this.client.assertTradable();
    const placed = await this.client.placeOrder({
      instId,
      tdMode: "cash",
      side: sideRaw,
      ordType: "market",
      sz,
      tgtCcy,
    });
    return {
      ...env,
      status: "placed",
      inst_id: instId,
      side: sideRaw,
      amount_usd: amountUsd,
      sz,
      tgt_ccy: tgtCcy,
      ord_id: placed.ordId,
      cost_usd: 0.005,
    };
  }

  /**
   * 永续市价开仓。金额 → 张数：现价 × 合约面值 ctVal 求张数，向下
   * 取 lotSz 整数倍；低于最小量直接拒绝（不把非法单发给 OKX）。
   * 做多 side=buy/posSide=long，做空 side=sell/posSide=short，全仓 cross。
   */
  private async perpOrder(
    args: Record<string, unknown>,
    mode: string,
    env: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const instId = str(args.inst_id, "inst_id").toUpperCase();
    if (!instId.endsWith("-SWAP")) {
      throw new GuardrailDenied(
        `okx.perp_order 的 inst_id 须为永续合约（形如 BTC-USDT-SWAP），收到 ${instId}`,
      );
    }
    const sideRaw = str(args.side, "side").toLowerCase();
    if (sideRaw !== "long" && sideRaw !== "short") {
      throw new GuardrailDenied(`okx.perp_order 的 side 只允许 long/short，收到 ${sideRaw}`);
    }
    const amountUsd = num(args.amount_usd, "amount_usd");
    if (!(amountUsd > 0)) throw new GuardrailDenied("okx.perp_order 需要正数 amount_usd");
    const tick = await this.client.ticker(instId);
    const price = Number(tick.last);
    if (!(price > 0)) throw new GuardrailDenied(`okx 现价异常：${instId} = ${tick.last}`);
    const inst = await this.client.instrument(instId);
    const ctVal = Number(inst.ctVal);
    if (!(ctVal > 0)) throw new GuardrailDenied(`okx 合约面值异常：${instId} ctVal=${inst.ctVal}`);
    const contracts = floorToLot(amountUsd / (price * ctVal), inst.lotSz);
    if (!(contracts > 0)) {
      throw new GuardrailDenied(
        `金额过小：$${amountUsd} 按现价约合 ${(amountUsd / (price * ctVal)).toFixed(4)} 张，` +
          `低于最小下单量 ${inst.lotSz} 张`,
      );
    }
    if (mode === "simulate") {
      return {
        ...env,
        status: "preview",
        note: "试运行不下单：正式运行经审批后在 OKX 执行（默认模拟盘）",
        inst_id: instId,
        side: sideRaw,
        amount_usd: amountUsd,
        price_usd: price,
        contracts,
        cost_usd: 0.001,
      };
    }
    if (mode !== "execute") {
      throw new GuardrailDenied(`okx.perp_order 不接受 mode=${mode}`);
    }
    this.client.assertTradable();
    const placed = await this.client.placeOrder({
      instId,
      tdMode: "cross",
      side: sideRaw === "long" ? "buy" : "sell",
      posSide: sideRaw,
      ordType: "market",
      sz: String(contracts),
    });
    return {
      ...env,
      status: "placed",
      inst_id: instId,
      side: sideRaw,
      amount_usd: amountUsd,
      price_usd: price,
      contracts,
      ord_id: placed.ordId,
      cost_usd: 0.005,
    };
  }
}
