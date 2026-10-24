import { randomUUID } from "node:crypto";
import { GuardrailDenied, NotFound } from "../domain/errors.js";
import type {
  ApprovalStore,
  ChatStore,
  FeedStore,
  RunStore,
  RuntimePort,
  ScriptDraftSaver,
} from "../domain/ports.js";
import { TOOL_RISKS, type Approval, type Chat, type Message, type RunRecord } from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";

/** 回复生成函数（组合根注入具体实现；本层不依赖任何具体模型/模拟实现）。 */
export type ReplyGenerator = (goal: string) => string;

export interface CreateChatInput {
  title?: string;
  kind?: string;
  feedItemId?: string | null;
  scene?: string;
}

/**
 * 聊天用例：建话题、发消息（经 RuntimePort 发起运行、事件落 RunStore、
 * assistant 消息落库）、审批挂起时补建 Approval 行、批准后在原 Run 上续跑。
 * 与 Python ChatService 同口径：scene 由本服务登记（Chat 记录不带 scene 字段）。
 */
export class ChatService {
  private readonly sessionByChat = new Map<string, string>();
  private readonly sceneByChat = new Map<string, string>();

  constructor(
    private readonly chats: ChatStore,
    private readonly runs: RunStore,
    private readonly approvals: ApprovalStore,
    private readonly runtime: RuntimePort,
    private readonly userId: string,
    private readonly replyFor: ReplyGenerator,
    private readonly feedStore?: FeedStore,
    private readonly scriptSaver?: ScriptDraftSaver,
  ) {}

  // ---------- 话题 ----------

  createChat(input: CreateChatInput): Chat {
    const kind = input.kind === "side" || input.kind === "topic" ? "side" : "main";
    const now = nowIso();
    const chat: Chat = {
      id: randomUUID(),
      userId: this.userId,
      title: input.title?.trim() || (kind === "side" ? "新话题" : "主聊"),
      kind,
      feedItemId: input.feedItemId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.chats.createChat(chat);
    if (input.scene) this.sceneByChat.set(chat.id, input.scene);
    // 带入精选上下文（同 Python create_chat）：落一条 system 消息，
    // 实体以 k=v 形式拼入，话题页与后续构建草稿都能看到来源条目。
    if (input.feedItemId && this.feedStore) {
      const item = this.feedStore.getFeedItem(input.feedItemId);
      if (item) {
        const entities = Object.entries(item.entities ?? {})
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ");
        this.addMessage(
          chat.id,
          "system",
          `【精选上下文】${item.title}——${item.summary}（实体：${entities}）`,
        );
      }
    }
    return chat;
  }

  listChats(): Chat[] {
    return this.chats.listChats(this.userId);
  }

  getChat(chatId: string): Chat {
    const chat = this.chats.getChat(chatId);
    if (!chat) throw new NotFound(`会话不存在：${chatId}`);
    return chat;
  }

  listMessages(chatId: string): Message[] {
    this.getChat(chatId);
    return this.chats.listMessages(chatId);
  }

  sceneOf(chat: Chat): string {
    const registered = this.sceneByChat.get(chat.id);
    if (registered) return registered;
    if (chat.feedItemId && chat.title.includes("构建")) return "script_build";
    return "chat";
  }

  // ---------- 发送一轮 ----------

  async send(chatId: string, text: string): Promise<{ runId: string; reply: string }> {
    const chat = this.getChat(chatId);
    const scene = this.sceneOf(chat);
    this.addMessage(chat.id, "user", text);
    const sessionId = this.sessionFor(chat, scene);

    const run = this.newRun(chat, scene);
    this.runs.createRun(run);

    const drafts = [];
    for await (const draft of this.runtime.invoke(sessionId, text, {
      scene,
      chatId: chat.id,
      source: "chat",
      userId: this.userId,
      runId: run.id,
    })) {
      drafts.push(draft);
    }
    if (drafts.length === 0) throw new GuardrailDenied("运行时未产出任何事件");
    for (const draft of drafts) {
      if (draft.type === "approval_required") {
        this.createApprovalFromEvent(run.id, draft.payload);
      }
    }
    // 回复由确定性模拟口径生成并落为 assistant 消息 + assistant_delta 事件（同 Python）。
    const reply = this.replyFor(text);
    this.addMessage(chat.id, "assistant", reply);
    this.runs.addEvent(run.id, { type: "assistant_delta", payload: { text: reply } });
    // script_build 话题：把这次做法保存/更新为同名脚本（同 Python _save_script_from_chat）。
    if (scene === "script_build" && this.scriptSaver) {
      const note = this.scriptSaver.saveFromChat({
        chatId: chat.id,
        userText: text,
        feedItemId: chat.feedItemId,
      });
      if (note) this.addMessage(chat.id, "assistant", note);
    }
    return { runId: run.id, reply };
  }

  /** 批准后续跑：由 ApprovalService 决策生效后调用，在原 Run 上继续。 */
  async resumeAfterApproval(run: RunRecord, approval: Approval): Promise<void> {
    if (!run.chatId) return;
    const chat = this.getChat(run.chatId);
    const sessionId = this.sessionFor(chat, this.sceneOf(chat));
    let suspendedAgain = false;
    let failed = false;
    for await (const draft of this.runtime.invoke(sessionId, "", {
      scene: this.sceneOf(chat),
      chatId: chat.id,
      source: "chat",
      userId: this.userId,
      resumeRunId: run.id,
      approvedStep: approval.stepIndex,
    })) {
      if (draft.type === "approval_required") {
        suspendedAgain = true;
        this.createApprovalFromEvent(run.id, draft.payload);
      }
      if (draft.type === "run_failed") failed = true;
    }
    const text =
      suspendedAgain || failed
        ? "执行又停下了，请看「待我确认」或执行记录。"
        : "已按你的批准继续执行完毕。";
    this.addMessage(chat.id, "assistant", text);
  }

  /** 拒绝收口：由 ApprovalService 调用（落 run_failed 事件 + 状态 + 助手消息）。 */
  denyRun(run: RunRecord, reason: string): void {
    if (run.status === "awaiting_approval") {
      this.runs.addEvent(run.id, {
        type: "run_failed",
        payload: { reason: "denied", error: reason || "用户拒绝" },
      });
      this.runs.setRunError(run.id, reason || "denied");
      this.runs.updateRunStatus(run.id, "failed");
    }
    if (run.chatId) {
      this.addMessage(
        run.chatId,
        "assistant",
        `已拒绝该操作${reason ? "：" + reason : ""}，任务已停止。`,
      );
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const viaRuntime = await this.runtime.cancel(runId);
    if (viaRuntime) return true;
    const run = this.runs.getRun(runId);
    if (run && run.status === "running") {
      this.runs.updateRunStatus(runId, "cancelled");
      return true;
    }
    return false;
  }

  // ---------- 内部 ----------

  private sessionFor(chat: Chat, scene: string): string {
    let sessionId = this.sessionByChat.get(chat.id);
    if (!sessionId) {
      sessionId = this.runtime.createSession(this.userId, scene).id;
      this.sessionByChat.set(chat.id, sessionId);
    }
    return sessionId;
  }

  private newRun(chat: Chat, scene: string): RunRecord {
    const now = nowIso();
    return {
      id: randomUUID(),
      userId: this.userId,
      chatId: chat.id,
      scriptId: null,
      jobId: null,
      scene,
      source: "chat",
      status: "running",
      costUsd: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    };
  }

  private addMessage(chatId: string, role: Message["role"], content: string): void {
    this.chats.addMessage({
      id: randomUUID(),
      chatId,
      role,
      content,
      createdAt: nowIso(),
    });
  }

  /**
   * 按挂起事件补建 Approval 行（同 Python 口径）：金额先取事件 payload，
   * 否则扫本 run 已落库 tool_called 事件的 args（amount_usd/amount）；
   * 风险先取 payload，否则按工具名查 TOOL_RISKS，查不到回退 write。不重演计划猜数。
   */
  private createApprovalFromEvent(
    runId: string,
    payload: Record<string, unknown>,
  ): Approval {
    const stepPath = String(payload.step ?? "0");
    const head = stepPath.split(".", 1)[0] ?? "0";
    const stepIndex = /^\d+$/.test(head) ? Number(head) : 0;
    const toolName = String(payload.tool ?? "");

    let amount: number | null = null;
    if (typeof payload.amount_usd === "number") {
      amount = payload.amount_usd;
    } else {
      for (const past of this.runs.listEvents(runId, 0)) {
        if (past.type !== "tool_called") continue;
        const args = (past.payload.args ?? {}) as Record<string, unknown>;
        for (const key of ["amount_usd", "amount"]) {
          if (typeof args[key] === "number") amount = args[key] as number;
        }
      }
    }
    const risk =
      (typeof payload.risk === "string" && payload.risk) ||
      TOOL_RISKS[toolName] ||
      "write";
    const approval: Approval = {
      id: randomUUID(),
      runId,
      stepIndex,
      action: toolName || String(payload.label ?? "敏感操作"),
      risk,
      amountUsd: amount,
      status: "pending",
      reason: "",
      createdAt: nowIso(),
      decidedAt: "",
    };
    this.approvals.createApproval(approval);
    return approval;
  }
}
