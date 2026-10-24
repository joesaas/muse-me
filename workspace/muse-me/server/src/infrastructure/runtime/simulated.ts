/**
 * 确定性模拟计划器（与 Python 包 llm.MockModel 同口径）：同一输入同一计划，
 * 无随机、无网络。所有结果明确标注 simulated —— 这里是「本地运行时」的计划来源，
 * 不是通用 LLM。计划形状：plan 步是工具调用，敏感步（write）标 needsApproval。
 */

export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
  label: string;
  saveAs?: string;
  needsApproval: boolean;
  costUsd: number;
}

export interface SimulatedPlan {
  goal: string;
  scene: string;
  steps: PlanStep[];
  amountDefaulted: boolean;
}

const KNOWN_TOKENS = [
  "BONK", "PEPE", "DOGE", "SHIB", "WIF", "FLOKI",
  "SOL", "ETH", "BTC", "AAVE", "UNI", "LINK",
] as const;

const STEP_COSTS: Readonly<Record<string, number>> = {
  "meme.scan": 0.002,
  "dex.quote": 0.002,
  "dex.sim_swap": 0.003,
  "market.quote": 0.001,
  "aave.rates": 0.001,
  "aave.sim_supply": 0.003,
  "news.search": 0.001,
};

const TOKEN_RE = /\b[A-Z][A-Z0-9]{1,9}\b/g;
const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(?:美元|USD|刀|块)/;

export function findToken(text: string): string | undefined {
  const upper = text.toUpperCase();
  const candidates = upper.match(TOKEN_RE) ?? [];
  for (const cand of candidates) {
    if ((KNOWN_TOKENS as readonly string[]).includes(cand)) return cand;
  }
  return candidates[0];
}

/** 抽金额；漏抽默认 100 并留痕（amountDefaulted），不静默猜。 */
export function findAmount(text: string): { amount: number; defaulted: boolean } {
  const m = AMOUNT_RE.exec(text);
  if (m) return { amount: Number(m[1]), defaulted: false };
  return { amount: 100, defaulted: true };
}

function step(
  tool: string,
  args: Record<string, unknown>,
  label: string,
  opts: { saveAs?: string; needsApproval?: boolean } = {},
): PlanStep {
  return {
    tool,
    args,
    label,
    saveAs: opts.saveAs,
    needsApproval: opts.needsApproval ?? false,
    costUsd: STEP_COSTS[tool] ?? 0.001,
  };
}

/** 按场景与目标产计划：买 meme 六步口径 / Aave 利率口径 / 纯对话空计划。 */
export function buildPlan(scene: string, goal: string): SimulatedPlan {
  const lower = goal.toLowerCase();
  const isAave = lower.includes("aave") || goal.includes("利率") || goal.includes("收益");
  const { amount, defaulted } = findAmount(goal);
  const token = findToken(goal);

  if (isAave) {
    const asset = token && token !== "AAVE" ? token : "USDC";
    return {
      goal,
      scene,
      amountDefaulted: defaulted,
      steps: [
        step("aave.rates", { asset }, "查 Aave 利率", { saveAs: "rates" }),
        step("aave.sim_supply", { asset, amount_usd: amount }, "模拟存入", {
          saveAs: "supply",
          needsApproval: true,
        }),
      ],
    };
  }

  const wantsBuy = goal.includes("买") || lower.includes("meme") || lower.includes("buy");
  if (scene === "script_build" || wantsBuy) {
    const target = token ?? "BONK";
    return {
      goal,
      scene,
      amountDefaulted: defaulted,
      steps: [
        step("meme.scan", { token: target }, "查流动性与风险", { saveAs: "scan" }),
        step("dex.quote", { token: target, amount_usd: amount }, "报价", { saveAs: "quote" }),
        step("dex.sim_swap", { token: target, amount_usd: amount }, "模拟成交", {
          saveAs: "swap",
          needsApproval: true,
        }),
      ],
    };
  }

  if (token) {
    return {
      goal,
      scene,
      amountDefaulted: defaulted,
      steps: [step("market.quote", { symbol: token }, "查现价", { saveAs: "quote" })],
    };
  }

  return { goal, scene, amountDefaulted: defaulted, steps: [] };
}

/** 确定性伪造但稳定的数值（按字符串哈希），保证同输入同输出。 */
function stableUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** 模拟工具执行：结果形状对齐 Python 包 tools.py，统一带 source: "simulated"。 */
export function runSimulatedTool(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const token = String(args.token ?? args.symbol ?? "BONK");
  const amount = typeof args.amount_usd === "number" ? args.amount_usd : 100;
  switch (tool) {
    case "meme.scan": {
      const liquidity = Math.round(500_000 + stableUnit(token) * 9_500_000);
      return {
        token,
        liquidity_usd: liquidity,
        risk_level: liquidity > 1_000_000 ? "low" : "high",
        source: "simulated",
      };
    }
    case "dex.quote": {
      const price = 0.00001 + stableUnit(token + ":price") * 0.001;
      return {
        token,
        amount_usd: amount,
        price,
        slippage_pct: Number((stableUnit(token + ":slip") * 0.5).toFixed(3)),
        source: "simulated",
      };
    }
    case "dex.sim_swap":
      return {
        token,
        amount_usd: amount,
        status: "simulated_filled",
        tx: `sim-${token}-${Math.round(amount)}`,
        source: "simulated",
      };
    case "market.quote":
      return {
        symbol: token,
        price: 10 + stableUnit(token) * 3000,
        source: "simulated",
      };
    case "aave.rates": {
      const asset = String(args.asset ?? "USDC");
      return { asset, supply_apy: Number((2 + stableUnit(asset) * 4).toFixed(2)), source: "simulated" };
    }
    case "aave.sim_supply": {
      const asset = String(args.asset ?? "USDC");
      return {
        asset,
        amount_usd: amount,
        status: "simulated_supplied",
        est_yearly_usd: Number((amount * 0.04).toFixed(2)),
        source: "simulated",
      };
    }
    case "news.search":
      return { query: String(args.query ?? ""), hits: 0, source: "simulated" };
    default:
      return { note: `工具 ${tool} 的模拟结果`, source: "simulated" };
  }
}

/** 确定性模拟回复（与 Python MockModel.complete 同口径的话术分支）。 */
export function completeReply(goal: string): string {
  const lower = goal.toLowerCase();
  if (lower.includes("aave") || goal.includes("利率") || goal.includes("收益")) {
    return (
      "（模拟回复）可以先查 Aave 各资产利率，再做模拟存入测算，" +
      "全程只模拟、不动真钱；满意后可存成脚本并设定时任务定期重跑。"
    );
  }
  const token = findToken(goal);
  if (lower.includes("meme") || token) {
    const target = token ?? "该标的";
    return (
      `（模拟回复）已定位标的 ${target}。按脚本构建六步：先查流动性与风险，` +
      "再报价、模拟成交，敏感步骤停在审批，确认后保存为脚本可重跑。"
    );
  }
  return `（模拟回复）已收到：${goal.slice(0, 80)}。我可以陪你把它变成可保存、可重跑的脚本。`;
}
