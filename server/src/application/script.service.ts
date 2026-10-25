import { randomUUID } from "node:crypto";
import { NotFound } from "../domain/errors.js";
import type { FeedStore, ScriptStore } from "../domain/ports.js";
import type {
  FeedItemRecord,
  ScriptDoc,
  ScriptRecord,
} from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";
import {
  ScriptEngine,
  type ScriptRunResult,
} from "./script-engine.js";

/**
 * 脚本用例（同 Python ScriptService）：列表/详情/草稿构建/保存/运行/试运行/续跑。
 * 同时实现 ScriptDraftSaver：script_build 话题发送后把草稿按同名 upsert 保存。
 */
export class ScriptService {
  constructor(
    private readonly engine: ScriptEngine,
    private readonly scripts: ScriptStore,
    private readonly feed: FeedStore,
    private readonly userId: string,
  ) {}

  list(): ScriptRecord[] {
    return this.scripts.listScripts(this.userId);
  }

  get(scriptId: string): ScriptRecord {
    const script = this.scripts.getScript(scriptId);
    if (!script) throw new NotFound(`脚本不存在：${scriptId}`);
    return script;
  }

  /** 构建草稿并校验（/api/scripts/build 口径）。 */
  buildDraft(intent: string, feedItem?: FeedItemRecord | null): ScriptDoc {
    const draft = this.engine.buildDraft(intent, feedItem);
    this.engine.validateScript(draft);
    return draft;
  }

  async run(
    scriptId: string,
    options: {
      params?: Record<string, unknown>;
      trial?: boolean;
      source?: string;
      jobId?: string | null;
      entity?: Record<string, unknown> | null;
      version?: number | null;
    } = {},
  ): Promise<ScriptRunResult> {
    const script = this.get(scriptId);
    let doc: ScriptDoc | undefined;
    if (
      options.version !== undefined &&
      options.version !== null &&
      options.version !== script.currentVersion
    ) {
      const versioned = this.scripts.getScriptVersion(scriptId, options.version);
      if (!versioned) {
        throw new NotFound(`脚本版本不存在：${scriptId} v${options.version}`);
      }
      doc = versioned.doc;
    }
    return this.engine.runScript({
      script,
      params: options.params,
      trial: options.trial,
      source: options.source,
      jobId: options.jobId,
      entity: options.entity,
      doc,
    });
  }

  async trial(scriptId: string, params?: Record<string, unknown>): Promise<ScriptRunResult> {
    return this.run(scriptId, { params, trial: true, source: "script_trial" });
  }

  async resume(runId: string): Promise<ScriptRunResult> {
    return this.engine.resumeScript(runId);
  }

  /**
   * ScriptDraftSaver 实现（同 Python ChatService._save_script_from_chat）：
   * 按话题来源精选构建草稿，同名脚本更新 doc（版本递增），返回提示文案。
   */
  saveFromChat(input: {
    chatId: string;
    userText: string;
    feedItemId: string | null;
  }): string {
    const item = input.feedItemId
      ? this.feed.getFeedItem(input.feedItemId)
      : undefined;
    const draft = this.engine.buildDraft(input.userText, item ?? null);
    const name = String(draft.name);
    const description = String(draft.description ?? "");
    const existing = this.scripts
      .listScripts(this.userId)
      .find((s) => s.name === name);
    let saved: ScriptRecord;
    if (existing) {
      existing.doc = draft;
      existing.description = description;
      existing.originChatId = input.chatId;
      existing.originFeedItemId = input.feedItemId;
      saved = this.scripts.updateScript(existing);
    } else {
      const now = nowIso();
      saved = this.scripts.createScript({
        id: randomUUID(),
        userId: this.userId,
        name,
        description,
        doc: draft,
        currentVersion: 1,
        originChatId: input.chatId,
        originFeedItemId: input.feedItemId,
        createdAt: now,
        updatedAt: now,
      });
    }
    return (
      `已把这次做法存成脚本《${saved.name}》，` +
      "在「插件」里可以试运行、改参数重跑，或设为定时任务。"
    );
  }
}
