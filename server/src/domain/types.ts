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
