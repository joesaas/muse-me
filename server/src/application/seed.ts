import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChatStore,
  FileStore,
  JobStore,
  MemoryStore,
  PromptStore,
  ScriptStore,
} from "../domain/ports.js";
import type { ScriptDoc, ScriptRecord } from "../domain/types.js";
import { nowIso, transaction } from "../infrastructure/sqlite/database.js";

/**
 * 演示种子（移植 Python seed.py）：库中无脚本时一次性写入——
 * feed 提示词 v1、主聊、示例脚本 2 个、Aave 定时任务 1 个、记忆 2 条、
 * 脚本导出文件登记 2 条。已有脚本（用户数据）时整批跳过，绝不覆盖。
 */

export const FEED_PROMPT_V1 =
  "我想看什么：DeFi、meme 和市场大盘都看，重点关注 meme 新币异动、" +
  "Aave 等借贷协议的利率与治理动态。";

export const MEME_SCRIPT_DOC: ScriptDoc = {
  name: "新闻驱动 meme 买入",
  description: "从新闻定位 meme 标的：查流动性与风险 → 报价 → 审批后模拟成交。",
  entity: { token: "BONK", chain: "solana" },
  params: [
    { key: "amount_usd", label: "买入金额（美元）", type: "number", default: 100 },
    { key: "token", label: "代币", type: "string", default: "${entity.token}" },
  ],
  steps: [
    { tool: "meme.scan", args: { token: "${token}" }, save_as: "scan" },
    {
      tool: "dex.quote",
      args: { token: "${token}", amount_usd: "${amount_usd}" },
      save_as: "quote",
    },
  ],
  requires_approval_before_step: 2,
  final_step: {
    tool: "dex.sim_swap",
    args: { token: "${token}", amount_usd: "${amount_usd}" },
  },
};

export const AAVE_SCRIPT_DOC: ScriptDoc = {
  name: "Aave 收益脚本",
  description: "查 Aave 利率并模拟存入测算收益（只模拟，不动真钱）。",
  params: [
    { key: "asset", label: "资产", type: "string", default: "USDC" },
    { key: "amount_usd", label: "存入金额（美元）", type: "number", default: 1000 },
    { key: "days", label: "测算天数", type: "number", default: 365 },
  ],
  steps: [
    { tool: "aave.rates", args: { asset: "${asset}" }, save_as: "rates" },
  ],
  requires_approval_before_step: 1,
  final_step: {
    tool: "aave.sim_supply",
    args: { asset: "${asset}", amount_usd: "${amount_usd}", days: "${days}" },
  },
};

export interface SeedStores {
  chats: ChatStore;
  prompts: PromptStore;
  scripts: ScriptStore;
  files: FileStore;
  jobs: JobStore;
  memories: MemoryStore;
}

function makeScript(userId: string, doc: ScriptDoc): ScriptRecord {
  const now = nowIso();
  return {
    id: randomUUID(),
    userId,
    name: String(doc.name),
    description: String(doc.description ?? ""),
    doc,
    currentVersion: 1,
    originChatId: null,
    originFeedItemId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 带共享连接句柄的 store（Sqlite* store 均提供 database getter）。 */
interface HasDatabase {
  database?: DatabaseSync;
}

/**
 * 从各 store 取共享连接：恰好一个时返回它（生产组合根的六个 store 共享
 * 同一连接，故生产路径走事务，且无需改组合根）；无句柄（mock store）
 * 或多连接时返回 undefined，调用方退化为顺序执行。
 */
function sharedDatabase(stores: SeedStores): DatabaseSync | undefined {
  const handles = new Set<DatabaseSync>();
  for (const store of Object.values(stores)) {
    const handle = (store as HasDatabase).database;
    if (handle) handles.add(handle);
  }
  return handles.size === 1 ? [...handles][0] : undefined;
}

/**
 * 库中已有脚本则整批跳过（返回 false）；完成播种返回 true。
 * 整批写入包在唯一共享连接的事务内：中途失败整批回滚，不留半份种子。
 * 已有脚本的跳过判断在事务外做（只读，不开事务）。
 */
export function seedIfEmpty(stores: SeedStores, userId: string): boolean {
  if (stores.scripts.listScripts(userId).length > 0) return false;
  const db = sharedDatabase(stores);
  if (db) return transaction(db, () => seedIfEmptyBody(stores, userId));
  return seedIfEmptyBody(stores, userId);
}

function seedIfEmptyBody(stores: SeedStores, userId: string): boolean {
  const now = nowIso();

  if (!stores.prompts.getPrompt(userId, "feed")) {
    stores.prompts.setPrompt(userId, "feed", FEED_PROMPT_V1);
  }
  if (stores.chats.listChats(userId).length === 0) {
    stores.chats.createChat({
      id: randomUUID(),
      userId,
      title: "主聊",
      kind: "main",
      feedItemId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const meme = stores.scripts.createScript(makeScript(userId, MEME_SCRIPT_DOC));
  const aave = stores.scripts.createScript(makeScript(userId, AAVE_SCRIPT_DOC));

  for (const script of [meme, aave]) {
    const blob = JSON.stringify(script.doc, null, 2);
    stores.files.addFile({
      userId,
      name: `${script.name}.json`,
      kind: "script_export",
      ref: `script:${script.id}`,
      size: Buffer.byteLength(blob, "utf8"),
    });
  }

  stores.jobs.createJob({
    id: randomUUID(),
    userId,
    name: "每小时看 Aave 收益",
    scriptId: aave.id,
    scriptVersion: null,
    triggerType: "time",
    triggerSpec: { every_minutes: 60 },
    params: {},
    enabled: true,
    nextFireAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: now,
  });

  stores.memories.addMemory({
    id: randomUUID(),
    userId,
    content: "用户偏好简洁、结论先行的回复。",
    level: "fact",
    status: "active",
    source: "seed",
    createdAt: now,
  });
  stores.memories.addMemory({
    id: randomUUID(),
    userId,
    content: "用户可能偏好 meme 赛道（待确认）。",
    level: "inference",
    status: "pending",
    source: "seed",
    createdAt: now,
  });
  return true;
}
