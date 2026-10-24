import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../src/application/approval.service.js";
import { ChatService } from "../src/application/chat.service.js";
import { ApprovalExpired } from "../src/domain/errors.js";
import { LocalRuntime } from "../src/infrastructure/runtime/local-runtime.js";
import { completeReply } from "../src/infrastructure/runtime/simulated.js";
import { openDatabase } from "../src/infrastructure/sqlite/database.js";
import { SqliteApprovalStore } from "../src/infrastructure/sqlite/approvals.store.js";
import { SqliteChatStore } from "../src/infrastructure/sqlite/chats.store.js";
import { SqliteRunStore } from "../src/infrastructure/sqlite/runs.store.js";

const USER = "demo-user";

function buildStack() {
  const db = openDatabase(":memory:");
  const chats = new SqliteChatStore(db);
  const runs = new SqliteRunStore(db);
  const approvals = new SqliteApprovalStore(db);
  const runtime = new LocalRuntime(runs);
  const chatService = new ChatService(chats, runs, approvals, runtime, USER, completeReply);
  const approvalService = new ApprovalService(approvals, runs, chatService, USER);
  return { db, chats, runs, approvals, runtime, chatService, approvalService };
}

let stack: ReturnType<typeof buildStack>;
afterEach(() => {
  stack?.db.close();
});

function backdateApproval(db: ReturnType<typeof openDatabase>, id: string, minutes: number): void {
  const old = new Date(Date.now() - minutes * 60_000).toISOString();
  db.prepare("UPDATE approvals SET created_at = ? WHERE id = ?").run(old, id);
}

describe("审批超时（与 Python 同口径）", () => {
  it("超 60 分钟未决：decide 抛 ApprovalExpired（410），审批 rejected，run failed", async () => {
    stack = buildStack();
    const chat = stack.chatService.createChat({ kind: "side", title: "新话题" });
    const { runId } = await stack.chatService.send(chat.id, "买这个 meme，100 美元");
    const pending = stack.approvals.listApprovals(USER, "pending");
    expect(pending).toHaveLength(1);
    backdateApproval(stack.db, pending[0]!.id, 61);
    let caught: unknown;
    try {
      await stack.approvalService.decide(pending[0]!.id, true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApprovalExpired);
    expect((caught as ApprovalExpired).httpStatus).toBe(410);
    expect((caught as Error).message).toContain("审批已过期");
    const after = stack.approvals.getApproval(pending[0]!.id);
    expect(after?.status).toBe("rejected");
    expect(after?.reason).toBe("approval_timeout");
    expect(stack.runs.getRun(runId)?.status).toBe("failed");
  });

  it("30 分钟内未决：decide 仍可批准", async () => {
    stack = buildStack();
    const chat = stack.chatService.createChat({ kind: "side", title: "新话题" });
    await stack.chatService.send(chat.id, "买这个 meme，100 美元");
    const pending = stack.approvals.listApprovals(USER, "pending");
    backdateApproval(stack.db, pending[0]!.id, 30);
    const decided = await stack.approvalService.decide(pending[0]!.id, true);
    expect(decided.status).toBe("approved");
  });

  it("expireStale 清扫过期 pending 且只清扫过期者", async () => {
    stack = buildStack();
    const chat = stack.chatService.createChat({ kind: "side", title: "新话题" });
    const { runId } = await stack.chatService.send(chat.id, "买这个 meme，100 美元");
    const pending = stack.approvals.listApprovals(USER, "pending");
    backdateApproval(stack.db, pending[0]!.id, 120);
    const count = stack.approvalService.expireStale();
    expect(count).toBe(1);
    expect(stack.approvals.getApproval(pending[0]!.id)?.status).toBe("rejected");
    expect(stack.runs.getRun(runId)?.status).toBe("failed");
    expect(stack.approvalService.expireStale()).toBe(0);
  });
});
