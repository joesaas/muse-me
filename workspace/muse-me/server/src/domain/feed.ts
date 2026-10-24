import { createHash } from "node:crypto";
import { extractToken } from "./extract.js";
import type { FeedItemRecord, RawNewsItem } from "./types.js";

/**
 * 精选生成（纯函数，移植 Python feed.py 口径）：
 * 从提示词抽关键词（话题词表 + 大写代币 + 中文片段），逐条打分排序；
 * 有关键词却零命中时回退全池并给条目打 fallback 标记，不静默冒充命中。
 * 条目 id 由 source+title 的 sha1 前 32 位决定，多次刷新不变。
 */

export function stableItemId(source: string, title: string): string {
  return createHash("sha1").update(`${source}\n${title}`, "utf8").digest("hex").slice(0, 32);
}

const TOPIC_WORDS = [
  "meme", "defi", "market", "aave", "solana", "ethereum", "bitcoin",
  "uniswap", "etf", "借贷", "利率", "治理", "投票", "流动性",
  "比特币", "以太坊", "新币", "大盘", "市场",
];
const STOP = new Set(["我想看", "我想", "关注", "重点", "都看", "动态", "相关", "新闻", "每日"]);

export function extractKeywords(promptText: string): string[] {
  const text = promptText ?? "";
  const lowered = text.toLowerCase();
  const found: string[] = [];
  for (const word of TOPIC_WORDS) {
    if (lowered.includes(word) && !found.includes(word)) found.push(word);
  }
  for (const token of text.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? []) {
    if (token !== "USD" && !found.includes(token.toLowerCase())) {
      found.push(token.toLowerCase());
    }
  }
  for (const chunk of text.match(/[\u4E00-\u9FFF]{2,4}/g) ?? []) {
    if (!STOP.has(chunk) && !found.includes(chunk)) found.push(chunk);
  }
  return found;
}

/** 实体抽取：池内 entities 为主，缺 token 时从标题/摘要抽代币补齐，缺 topic 时补 topic。 */
export function extractEntities(item: RawNewsItem): Record<string, unknown> {
  const entities: Record<string, unknown> = { ...(item.entities ?? {}) };
  if (!entities.token) {
    const token = extractToken(`${item.title ?? ""} ${item.summary ?? ""}`);
    if (token) entities.token = token;
  }
  if (item.topic && !entities.topic) entities.topic = item.topic;
  return entities;
}

/** Python str(dict) 的近似（打分 haystack 用；池内实体值均为字符串）。 */
function pythonDictStr(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(
    ([k, v]) => `'${k}': ${typeof v === "string" ? `'${v}'` : String(v)}`,
  );
  return `{${parts.join(", ")}}`;
}

export type GeneratedFeedItem = Omit<FeedItemRecord, "userId" | "createdAt" | "promptVersion">;

const BASE_DATE = "2026-10-23";

/** 按提示词对全池打分生成精选条目（未落库；顺序为排名序，同 Python generate）。 */
export function generateFeedItems(pool: RawNewsItem[], promptText: string): GeneratedFeedItem[] {
  const keywords = extractKeywords(promptText);
  const scored = pool.map((raw, idx) => {
    const haystack =
      `${raw.title ?? ""} ${raw.summary ?? ""} ${raw.topic ?? ""} ${pythonDictStr(raw.entities ?? {})}`.toLowerCase();
    const score = keywords.filter((kw) => haystack.includes(kw)).length;
    return { score, idx, raw };
  });
  const isFallback = keywords.length > 0 && !scored.some((e) => e.score > 0);
  const kept =
    keywords.length > 0 && !isFallback ? scored.filter((e) => e.score > 0) : scored;
  kept.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return kept.map(({ idx, raw }) => {
    const source = String(raw.source ?? "SeedNews");
    const title = String(raw.title ?? "");
    const entities = extractEntities(raw);
    if (isFallback) entities.fallback = "未命中关注点";
    return {
      id: stableItemId(source, title),
      title,
      summary: String(raw.summary ?? ""),
      source,
      url: String(raw.url ?? ""),
      topic: String(raw.topic ?? ""),
      entities,
      publishedAt:
        raw.publishedAt ?? `${BASE_DATE}T${String(8 + idx).padStart(2, "0")}:00:00+0800`,
    };
  });
}
