import { afterEach, describe, expect, it } from "vitest";
import { InvalidTransition, NotFound } from "../src/domain/errors.js";
import { ApprovalService } from "../src/application/approval.service.js";
import { ChatService } from "../src/application/chat.service.js";
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

describe("LocalRuntime + ChatService：事件序列与审批挂起/续跑", () => {
  it("买 meme：plan_created…approval_required 挂起，批准后续跑到 run_done，已完成步不重复", async () => {
    stack = buildStack();
    const chat = stack.chatService.createChat({ kind: "side", title: "新话题" });
    const { runId } = await stack.chatService.send(chat.id, "买这个 meme，100 美元");

    const events = stack.runs.listEvents(runId, 0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("tool_called");
    expect(types).toContain("step_done");
    expect(types).toContain("approval_required");
    expect(types).not.toContain("run_done");
    expect(stack.runs.getRun(runId)?.status).toBe("awaiting_approval");

    const pending = stack.approvals.listApprovals(USER, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.amountUsd).toBe(100);
    expect(pending[0]?.action).toBe("dex.sim_swap");

    const decided = await stack.approvalService.decide(pending[0]!.id, true);
    expect(decided.status).toBe("approved");
    expect(stack.runs.getRun(runId)?.status).toBe("done");

    const all = stack.runs.listEvents(runId, 0);
    expect(all.map((e) => e.type)).toContain("run_done");
    // 每个步的 step_done 恰好一次：续跑不重跑已完成步
    const doneSteps = all
      .filter((e) => e.type === "step_done")
      .map((e) => String(e.payload.step));
    expect(doneSteps.sort()).toEqual(["0", "1", "2"]);
    // seq 严格递增无重复
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // assistant 消息已落库（回复 + 续跑完成提示）
    const messages = stack.chats.listMessages(chat.id);
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
    expect(stack.runs.getRun(runId)?.costUsd).toBeCloseTo(0.007, 6);
  });

  it("拒绝：Run 收口 failed 且不再续跑", async () => {
    stack = buildStack();
    const chat = stack.chatService.createChat({ kind: "side" });
    const { runId } = await stack.chatService.send(chat.id, "买这个 meme，50 美元");
    const pending = stack.approvals.listApprovals(USER, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.amountUsd).toBe(50);

    await stack.approvalService.decide(pending[0]!.id, false, "太贵了");
    expect(stack.runs.getRun(runId)?.status).toBe("failed");
    const types = stack.runs.listEvents(runId, 0).map((e) => e.type);
    expect(types).toContain("run_failed");
    expect(types).not.toContain("run_done");
  });
});

describe("ApprovalService 决策前置", () => {
  it("重复决策抛 InvalidTransition（409 口径）", async () => {
    stack = buildStack();
    const chat = stack.chatService.createChat({ kind: "side" });
    await stack.chatService.send(chat.id, "买这个 meme，100 美元");
    const [approval] = stack.approvals.listApprovals(USER, "pending");
    await stack.approvalService.decide(approval!.id, true);
    await expect(stack.approvalService.decide(approval!.id, true)).rejects.toBeInstanceOf(
      InvalidTransition,
    );
    await expect(stack.approvalService.decide(approval!.id, false)).rejects.toBeInstanceOf(
      InvalidTransition,
    );
  });

  it("不存在的审批抛 NotFound", async () => {
    stack = buildStack();
    await expect(stack.approvalService.decide("nope", true)).rejects.toBeInstanceOf(NotFound);
  });
});
