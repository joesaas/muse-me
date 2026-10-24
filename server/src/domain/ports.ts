import type {
  Approval,
  Chat,
  Message,
  RunEventDraft,
  RunEventRecord,
  RunRecord,
  RunStatus,
  SessionInfo,
} from "./types.js";

/**
 * 端口层：按聚合拆分的小接口（接口隔离），应用层只依赖这些接口，
 * 不依赖 SQLite / Fastify / AWS SDK（依赖倒置）。签名参考 Python 包 RuntimePort 五法。
 */

// ---------------- 存储端口（每聚合一个，不做巨型 Store 接口） ----------------

export interface ChatStore {
  createChat(chat: Chat): void;
  getChat(id: string): Chat | undefined;
  listChats(userId: string): Chat[];
  addMessage(message: Message): void;
  listMessages(chatId: string): Message[];
}

export interface RunStore {
  createRun(run: RunRecord): void;
  getRun(id: string): RunRecord | undefined;
  listRuns(userId: string): RunRecord[];
  updateRunStatus(id: string, status: RunStatus): void;
  setRunError(id: string, error: string): void;
  addRunCost(id: string, amountUsd: number): void;
  /** 落一条事件并分配 seq（单写语句内完成，seq 在同一 run 内严格递增）。 */
  addEvent(runId: string, draft: RunEventDraft): RunEventRecord;
  listEvents(runId: string, afterSeq?: number): RunEventRecord[];
}

export interface ApprovalStore {
  createApproval(approval: Approval): void;
  getApproval(id: string): Approval | undefined;
  listApprovals(userId: string, status?: string): Approval[];
  /**
   * 原子条件决策：仅当当前 status='pending' 时才更新（单条带条件 UPDATE）。
   * 返回 true 表示本次决策生效；false 表示已被决策过或不存在（由服务层再分型）。
   */
  decideApproval(id: string, decision: "approved" | "denied", reason: string): boolean;
}

/** 会话存储小接口：登录 token 的签发/校验与存储介质解耦。 */
export interface SessionStore {
  create(userId: string): string;
  resolve(token: string): string | undefined;
  revoke(token: string): void;
}

export interface Clock {
  nowIso(): string;
}

// ---------------- 运行时端口（五法，与 Python RuntimePort 对齐） ----------------

export interface InvokeContext {
  scene?: string;
  chatId?: string;
  /** chat | script | job | feed */
  source?: string;
  userId?: string;
  /** 由应用层先建 Run 时传入，运行时把事件落到这条 Run 上。 */
  runId?: string;
  /** 审批续跑：挂起中的 run id 与刚被批准的步序号。 */
  resumeRunId?: string;
  approvedStep?: number;
}

export interface RuntimePort {
  createSession(userId: string, scene: string): SessionInfo;
  invoke(
    sessionId: string,
    prompt: string,
    ctx?: InvokeContext,
  ): AsyncIterable<RunEventDraft>;
  streamEvents(runId: string, afterSeq?: number): AsyncIterable<RunEventRecord>;
  cancel(runId: string): Promise<boolean>;
  getTrace(runId: string): Promise<RunEventRecord[]>;
  health(): Promise<Record<string, unknown>>;
}

// ---------------- AgentCore 管理端口 ----------------

export interface AgentRuntimeSummary {
  id: string;
  arn?: string;
  name: string;
  version?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateRuntimeInput {
  name: string;
  containerUri?: string;
  roleArn?: string;
  networkMode?: "PUBLIC" | "VPC";
  description?: string;
}

export interface UpdateRuntimeInput {
  containerUri?: string;
  roleArn?: string;
  networkMode?: "PUBLIC" | "VPC";
  description?: string;
}

export interface AgentCorePort {
  health(): Promise<Record<string, unknown>>;
  listRuntimes(): Promise<AgentRuntimeSummary[]>;
  getRuntime(id: string): Promise<AgentRuntimeSummary>;
  createRuntime(input: CreateRuntimeInput): Promise<AgentRuntimeSummary>;
  updateRuntime(id: string, input: UpdateRuntimeInput): Promise<AgentRuntimeSummary>;
  deleteRuntime(id: string): Promise<void>;
}
