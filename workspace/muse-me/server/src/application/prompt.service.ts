import { NotFound } from "../domain/errors.js";
import type { PromptStore } from "../domain/ports.js";
import type { FeedService } from "./feed.service.js";

export interface PromptView {
  content: string;
  version: number;
}

/**
 * 提示词用例（同 Python api.py 的 prompts 路由口径）：版本化存储；
 * PUT 与 rollback 后都重新生成精选；rollback 把目标版本内容存为新版本。
 */
export class PromptService {
  constructor(
    private readonly prompts: PromptStore,
    private readonly feed: FeedService,
    private readonly userId: string,
  ) {}

  getFeed(): PromptView {
    const doc = this.prompts.getPrompt(this.userId, "feed");
    return { content: doc?.content ?? "", version: doc?.version ?? 0 };
  }

  setFeed(content: string): PromptView {
    const doc = this.prompts.setPrompt(this.userId, "feed", content);
    this.feed.refresh();
    return { content: doc.content, version: doc.version };
  }

  versions(): PromptView[] {
    return this.prompts
      .listPromptVersions(this.userId, "feed")
      .map((v) => ({ content: v.content, version: v.version }));
  }

  rollback(version: number): PromptView {
    const target = this.prompts
      .listPromptVersions(this.userId, "feed")
      .find((v) => v.version === version);
    if (!target) throw new NotFound("版本不存在");
    const doc = this.prompts.setPrompt(this.userId, "feed", target.content);
    this.feed.refresh();
    return { content: doc.content, version: doc.version };
  }
}
