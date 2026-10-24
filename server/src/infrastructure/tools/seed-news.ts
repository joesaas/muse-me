import type { NewsSourcePort } from "../../domain/ports.js";
import type { RawNewsItem } from "../../domain/types.js";

/**
 * 内置确定性新闻池（迁自 Python tools.py DEFAULT_NEWS_POOL，逐条照抄）：
 * 精选生成与 news.search 工具共用同一池，保证同源一致。
 */
export const DEFAULT_NEWS_POOL: RawNewsItem[] = [
  {
    title: "Solana 生态 meme 币 BONK 单日交易量创新高",
    summary: "BONK 流动性池深度一周内翻倍，社区热度持续升温。",
    source: "SeedNews",
    topic: "meme",
    entities: { token: "BONK", chain: "solana" },
  },
  {
    title: "Aave V4 提案进入治理投票，利率模型将升级",
    summary: "提案拟优化 USDC 与 ETH 借贷利率曲线，预计提升资金利用率。",
    source: "SeedNews",
    topic: "defi",
    entities: { protocol: "Aave", token: "AAVE" },
  },
  {
    title: "以太坊现货 ETF 连续五日净流入",
    summary: "机构资金持续流入，ETH 价格站稳 3400 美元上方。",
    source: "SeedNews",
    topic: "market",
    entities: { token: "ETH" },
  },
  {
    title: "某新发 meme 币 PEPE2 上线后流动性迅速枯竭",
    summary: "PEPE2 上线两小时后池深度不足一万美元，多名买家无法卖出。",
    source: "SeedNews",
    topic: "meme",
    entities: { token: "PEPE2", chain: "ethereum" },
  },
  {
    title: "Uniswap 推出聚合器 Hooks，DEX 报价竞争加剧",
    summary: "新 Hooks 机制允许第三方为兑换路径提供更优报价。",
    source: "SeedNews",
    topic: "defi",
    entities: { protocol: "Uniswap", token: "UNI" },
  },
  {
    title: "比特币突破 97000 美元，衍生品资金费率温和",
    summary: "BTC 创阶段新高，永续资金费率保持中性，现货买盘为主。",
    source: "SeedNews",
    topic: "market",
    entities: { token: "BTC" },
  },
];

/** NewsSourcePort 实现：内置种子新闻池（同 Python SeedNews.fetch 口径）。 */
export class SeedNewsSource implements NewsSourcePort {
  constructor(private readonly pool: RawNewsItem[] = DEFAULT_NEWS_POOL) {}

  fetch(query = "", limit = 20): RawNewsItem[] {
    const q = (query ?? "").toLowerCase();
    const hits: RawNewsItem[] = [];
    for (const item of this.pool) {
      const haystack =
        `${item.title ?? ""} ${item.summary ?? ""} ${item.topic ?? ""}`.toLowerCase();
      if (!q || haystack.includes(q)) hits.push({ ...item });
    }
    return hits.slice(0, limit);
  }
}
