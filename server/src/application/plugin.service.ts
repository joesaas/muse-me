import { randomUUID } from "node:crypto";
import { NotFound } from "../domain/errors.js";
import { PLUGIN_TEMPLATES, type PluginTemplate } from "../domain/plugin-catalog.js";
import type { ScriptStore } from "../domain/ports.js";
import type { ScriptDoc, ScriptRecord } from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";
import type { ScriptEngine } from "./script-engine.js";

/**
 * 插件用例：目录列表 / 按模板安装（按名 upsert 成脚本）。
 * 安装只改默认值（调用方传已知参数键覆盖模板默认值），不改步骤；
 * 安装后脚本走与对话共建脚本完全相同的运行/审批/定时任务链路。
 */

export interface PluginView extends Omit<PluginTemplate, "doc"> {
  params: ScriptDoc["params"];
  configured: boolean;
}

export class PluginService {
  constructor(
    private readonly scripts: ScriptStore,
    private readonly engine: ScriptEngine,
    private readonly userId: string,
    private readonly okxConfigured: () => boolean,
  ) {}

  list(): PluginView[] {
    return PLUGIN_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      provider: t.provider,
      description: t.description,
      requiresConnection: t.requiresConnection,
      params: t.doc.params ?? [],
      configured: t.requiresConnection === "okx" ? this.okxConfigured() : true,
    }));
  }

  install(templateId: string, overrides: Record<string, unknown> = {}): ScriptRecord {
    const template = PLUGIN_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new NotFound(`插件模板不存在：${templateId}`);
    const doc: ScriptDoc = JSON.parse(JSON.stringify(template.doc)) as ScriptDoc;
    const params = Array.isArray(doc.params) ? doc.params : [];
    for (const p of params as Array<Record<string, unknown>>) {
      const key = String(p.key);
      if (overrides[key] !== undefined) p.default = overrides[key];
    }
    this.engine.validateScript(doc);
    const existing = this.scripts
      .listScripts(this.userId)
      .find((s) => s.name === template.name);
    if (existing) {
      existing.doc = doc;
      existing.description = template.description;
      return this.scripts.updateScript(existing);
    }
    const now = nowIso();
    return this.scripts.createScript({
      id: randomUUID(),
      userId: this.userId,
      name: template.name,
      description: template.description,
      doc,
      currentVersion: 1,
      originChatId: null,
      originFeedItemId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}
