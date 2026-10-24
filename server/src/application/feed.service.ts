import { NotFound } from "../domain/errors.js";
import { generateFeedItems } from "../domain/feed.js";
import type {
  FeedStore,
  NewsSourcePort,
  PromptStore,
} from "../domain/ports.js";
import type { FeedItemRecord } from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";

/** 精选用例（同 Python FeedService）：refresh 按当前提示词重生成，list 读库。 */
export class FeedService {
  constructor(
    private readonly feed: FeedStore,
    private readonly prompts: PromptStore,
    private readonly news: NewsSourcePort,
    private readonly userId: string,
  ) {}

  list(limit = 50): FeedItemRecord[] {
    return this.feed.listFeedItems(this.userId, limit);
  }

  get(itemId: string): FeedItemRecord {
    const item = this.feed.getFeedItem(itemId);
    if (!item) throw new NotFound(`精选条目不存在：${itemId}`);
    return item;
  }

  refresh(): FeedItemRecord[] {
    const prompt = this.prompts.getPrompt(this.userId, "feed");
    const generated = generateFeedItems(
      this.news.fetch("", 10_000),
      prompt?.content ?? "",
    );
    const now = nowIso();
    const records: FeedItemRecord[] = generated.map((item) => ({
      ...item,
      userId: this.userId,
      promptVersion: prompt?.version ?? null,
      createdAt: now,
    }));
    this.feed.replaceFeedItems(this.userId, records);
    // Python refresh 返回 generate 的排名序列表（与 GET list 的库序不同），照此口径。
    return records;
  }
}
