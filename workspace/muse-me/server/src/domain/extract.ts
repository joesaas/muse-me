import { KNOWN_PRICES } from "./tool-catalog.js";

/**
 * 文本抽取（纯函数，与 Python 口径逐项对齐）：
 * - extractToken 对应 tools._extract_token（精选实体补抽 / meme.scan 兜底）；
 * - findToken / findAmount 对应 llm.MockModel 的 _find_token / _find_amount
 *   （脚本草稿构建的标的/金额抽取）。
 */

const TOKEN_RE = /\b[A-Z][A-Z0-9]{1,9}\b/g;
const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(?:美元|USD|刀|块)/;

function candidatesOf(text: string): string[] {
  return text.toUpperCase().match(TOKEN_RE) ?? [];
}

/** 从文本中抽取最像 meme 标的的大写代币符号（tools._extract_token）。 */
export function extractToken(text: string): string | undefined {
  const candidates = candidatesOf(text);
  for (const cand of candidates) {
    if (cand in KNOWN_PRICES || cand.endsWith("2") || cand.length >= 3) {
      if (!["USD", "APY", "DEX", "ETF"].includes(cand)) return cand;
    }
  }
  return candidates[0];
}

/** 计划器口径的标的抽取（llm._find_token）：已知价格表优先，否则第一个候选。 */
export function findToken(text: string): string | undefined {
  const candidates = candidatesOf(text);
  for (const cand of candidates) {
    if (cand in KNOWN_PRICES) return cand;
  }
  return candidates[0];
}

/** 抽金额；漏抽默认 100 并留痕（defaulted），不静默猜。 */
export function findAmount(text: string): { amount: number; defaulted: boolean } {
  const m = AMOUNT_RE.exec(text);
  if (m) return { amount: Number(m[1]), defaulted: false };
  return { amount: 100, defaulted: true };
}
