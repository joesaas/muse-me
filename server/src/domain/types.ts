/** 领域层：纯数据与规则，无 I/O、无框架依赖。字段与 frontend/src/types.ts 契约对齐。 */

export type ChatKind = "main" | "side";
export type MessageRole = "user" | "assistant" | "system" | "tool";

export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied";
export type RiskLevel = "read" | "write" | "irreversible";

export interface Chat {
  id: string;
  userId: string;
  title: string;
  kind: ChatKind;
  feedItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

/** RuntimePort.createSession 的返回：一次运行时会话。 */
export interface SessionInfo {
  id: string;
  userId: string;
  scene: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  userId: string;
  chatId: string | null;
  scriptId: string | null;
  jobId: string | null;
  scene: string;
  /** chat | script | job | feed */
  source: string;
  status: RunStatus;
  costUsd: number;
  error: string;
  createdAt: string;
  updatedAt: string;
}

/** invoke 产出的事件草稿：落库时由 RunStore 分配 id/seq/createdAt。 */
export interface RunEventDraft {
  type: string;
  payload: Record<string, unknown>;
}

export interface RunEventRecord extends RunEventDraft {
  id: string;
  runId: string;
  seq: number;
  createdAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  stepIndex: number;
  action: string;
  risk: string;
  amountUsd: number | null;
  status: ApprovalStatus;
  reason: string;
  createdAt: string;
  decidedAt: string;
}

/**
 * 原子工具风险表（与 Python 包 tools.py 的 _TOOL_DEFS 风险级一致）。
 * 这是领域数据：审批补建时按工具名查风险级，注册表查不到回退 write（从严）。
 */
export const TOOL_RISKS: Readonly<Record<string, RiskLevel>> = {
  "market.quote": "read",
  "meme.scan": "read",
  "dex.quote": "read",
  "dex.sim_swap": "write",
  "aave.rates": "read",
  "aave.sim_supply": "write",
  "news.search": "read",
  "web.fetch": "read",
  "notify.send": "write",
};

// ---------------- 二期聚合记录（feed / prompts / scripts / jobs / memories / files） ----------------

export interface FeedItemRecord {
  id: string;
  userId: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  topic: string;
  entities: Record<string, unknown>;
  /** 池内无时间时为 null，不编造。 */
  publishedAt: string | null;
  promptVersion: number | null;
  createdAt: string;
}

/** 新闻源原始条目（新闻池一行，落库前）。 */
export interface RawNewsItem {
  title: string;
  summary: string;
  source: string;
  topic: string;
  url?: string;
  entities?: Record<string, unknown>;
  publishedAt?: string;
}

export interface PromptRecord {
  id: string;
  userId: string;
  key: string;
  content: string;
  version: number;
  createdAt: string;
}

export type ScriptDoc = Record<string, unknown>;

export interface ScriptRecord {
  id: string;
  userId: string;
  name: string;
  description: string;
  doc: ScriptDoc;
  currentVersion: number;
  originChatId: string | null;
  originFeedItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptVersionRecord {
  id: string;
  scriptId: string;
  version: number;
  doc: ScriptDoc;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  userId: string;
  name: string;
  scriptId: string;
  scriptVersion: number | null;
  triggerType: string;
  triggerSpec: Record<string, unknown>;
  params: Record<string, unknown>;
  enabled: boolean;
  nextFireAt: string;
  createdAt: string;
}

export interface JobRunRecord {
  id: string;
  jobId: string;
  runId: string | null;
  scriptVersion: number | null;
  status: string;
  attempt: number;
  error: string;
  startedAt: string;
  finishedAt: string;
}

export interface MemoryRecord {
  id: string;
  userId: string;
  content: string;
  level: string;
  status: string;
  source: string;
  createdAt: string;
}

export interface FileRecord {
  id: string;
  userId: string;
  name: string;
  kind: string;
  ref: string;
  size: number;
  createdAt: string;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface SecretRefRecord {
  name: string;
  ref: string;
  createdAt: string;
}

/** 挂起运行的续跑快照（run_snapshots 表一行；payload 按 kind 解释）。 */
export interface RunSnapshotRecord {
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  updatedAt: string;
}

/** kind="chat_plan" 的快照 payload：计划 + 挂起步 + 已花费，重启后据此重建挂起态。 */
export interface ChatPlanSnapshot {
  plan: unknown;
  nextIndex: number;
  spentUsd: number;
}

// ---------------- 护栏策略（与 Python domain.GuardrailPolicy 对应） ----------------

export interface GuardrailPolicy {
  maxCostPerRunUsd: number;
  maxCostPerDayUsd: number;
  maxSimAmountUsd: number;
  /** 待审批超时分钟数（policy.md 的 approval_timeout_minutes）。 */
  approvalTimeoutMinutes: number;
  riskLevels: Readonly<Record<string, string>>;
  approvalDefault: string;
}

/**
 * 类型默认值（仅作类型占位与测试兜底）。运行政策不得取自这里：
 * 组合根启动时解析 harness/guardrails/policy.md（见
 * infrastructure/guardrails/policy-file.ts），读不到或残缺即 fail-closed。
 */
export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  maxCostPerRunUsd: 1.0,
  maxCostPerDayUsd: 10.0,
  maxSimAmountUsd: 1000.0,
  approvalTimeoutMinutes: 60,
  riskLevels: {
    read: "auto",
    write: "batch_approval",
    irreversible: "single_approval",
  },
  approvalDefault: "deny",
};

/** fail-closed 政策：限额归零、全部单独审批（与 Python _fail_closed_policy 同口径）。 */
export const FAIL_CLOSED_GUARDRAIL_POLICY: GuardrailPolicy = {
  maxCostPerRunUsd: 0,
  maxCostPerDayUsd: 0,
  maxSimAmountUsd: 0,
  approvalTimeoutMinutes: 60,
  riskLevels: {
    read: "single_approval",
    write: "single_approval",
    irreversible: "single_approval",
  },
  approvalDefault: "deny",
};

/** 风险级 -> 处置：auto | batch_approval | single_approval | deny（未知从严）。 */
export function actionForRisk(policy: GuardrailPolicy, risk: string): string {
  return policy.riskLevels[risk] ?? policy.approvalDefault;
}
