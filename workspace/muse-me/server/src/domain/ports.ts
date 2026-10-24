import type {
  Approval,
  Chat,
  FeedItemRecord,
  FileRecord,
  JobRecord,
  JobRunRecord,
  MemoryRecord,
  Message,
  NotificationRecord,
  PromptRecord,
  RawNewsItem,
  RunEventDraft,
  RunEventRecord,
  RunRecord,
  RunSnapshotRecord,
  RunStatus,
  ScriptRecord,
  ScriptVersionRecord,
  SecretRefRecord,
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

// ---------------- 二期存储端口（按聚合拆分，延续一期小接口风格） ----------------

export interface FeedStore {
  replaceFeedItems(userId: string, items: FeedItemRecord[]): void;
  listFeedItems(userId: string, limit?: number): FeedItemRecord[];
  getFeedItem(id: string): FeedItemRecord | undefined;
}

export interface PromptStore {
  getPrompt(userId: string, key: string): PromptRecord | undefined;
  /** 写入新版本（版本号 = 当前最大 + 1），返回新版本记录。 */
  setPrompt(userId: string, key: string, content: string): PromptRecord;
  listPromptVersions(userId: string, key: string): PromptRecord[];
}

export interface ScriptStore {
  createScript(script: ScriptRecord): ScriptRecord;
  getScript(id: string): ScriptRecord | undefined;
  listScripts(userId: string): ScriptRecord[];
  /** 保存修改：版本号递增并落一条新 ScriptVersion（同 Python storage.update_script）。 */
  updateScript(script: ScriptRecord): ScriptRecord;
  getScriptVersion(
    scriptId: string,
    version: number,
  ): ScriptVersionRecord | undefined;
}

export interface JobStore {
  createJob(job: JobRecord): void;
  getJob(id: string): JobRecord | undefined;
  listJobs(userId: string): JobRecord[];
  updateJob(job: JobRecord): void;
  addJobRun(jobRun: JobRunRecord): void;
  listJobRuns(jobId: string): JobRunRecord[];
}

export interface MemoryStore {
  addMemory(item: MemoryRecord): void;
  getMemory(id: string): MemoryRecord | undefined;
  listMemories(userId: string, status?: string): MemoryRecord[];
  /**
   * 原子条件决策：仅当当前 status='pending' 时才更新（单条带条件 UPDATE）。
   * 返回 true 表示本次决策生效；false 表示已决策过或不存在（服务层再分型）。
   */
  decideMemory(id: string, approved: boolean): boolean;
  deleteMemory(id: string): boolean;
}

export interface FileStore {
  addFile(input: {
    userId: string;
    name: string;
    kind: string;
    ref: string;
    size?: number;
  }): FileRecord;
  listFiles(userId: string): FileRecord[];
  getFile(id: string): FileRecord | undefined;
}

export interface NotificationStore {
  addNotification(note: NotificationRecord): void;
  listNotifications(userId: string): NotificationRecord[];
}

/** 密钥引用存储：只存引用名与 ref，永不存明文。 */
export interface SecretRefStore {
  listSecretRefs(userId: string): SecretRefRecord[];
}

/** 运行快照存储：挂起运行的续跑状态落库（根治一期「计划只在进程内存」）。 */
export interface RunSnapshotStore {
  saveSnapshot(runId: string, kind: string, payload: Record<string, unknown>): void;
  getSnapshot(runId: string): RunSnapshotRecord | undefined;
  deleteSnapshot(runId: string): void;
}

// ---------------- 新闻源 / 工具注册表端口 ----------------

/** 新闻源端口（SeedNews 实现见 infrastructure；精选与 news.search 同源）。 */
export interface NewsSourcePort {
  fetch(query: string, limit: number): RawNewsItem[];
}

/** 原子工具注册表端口：白名单 + 确定性模拟实现，结果带 simulated 标注与 cost_usd。 */
export interface ToolRegistryPort {
  call(
    name: string,
    args: Record<string, unknown>,
    mode?: string,
  ): Record<string, unknown>;
  getTool(
    name: string,
  ): { name: string; risk: string; params: Readonly<Record<string, string>> } | undefined;
  hasTool(name: string): boolean;
}

/**
 * 聊天脚本构建的保存回调：script_build 话题发送后由 ChatService 调用，
 * 组合根注入 ScriptService 的实现，避免应用服务之间循环依赖
 * （与一期 replyFor 函数注入同一手法）。
 */
export interface ScriptDraftSaver {
  saveFromChat(input: {
    chatId: string;
    userText: string;
    feedItemId: string | null;
  }): string;
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
