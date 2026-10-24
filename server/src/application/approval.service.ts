import { InvalidTransition, NotFound } from "../domain/errors.js";
import type { ApprovalStore, RunStore } from "../domain/ports.js";
import type { Approval } from "../domain/types.js";
import type { ChatService } from "./chat.service.js";

/**
 * 审批用例：列表与决策。决策口径（评审定版）：
 * - 只允许对 pending 决策：先读分型（不存在 404 / 已决策 409），
 *   再经 store 的原子条件更新落决策，并发下只有一方生效；
 * - 批准后按 Run 来源续跑（本期只有 chat 来源，经 ChatService 在原 Run 上续）；
 * - 拒绝则把 Run 收口为 failed 并回一条助手消息。
 */
export class ApprovalService {
  constructor(
    private readonly approvals: ApprovalStore,
    private readonly runs: RunStore,
    private readonly chats: ChatService,
    private readonly userId: string,
  ) {}

  list(status?: string): Approval[] {
    return this.approvals.listApprovals(this.userId, status);
  }

  get(approvalId: string): Approval {
    const approval = this.approvals.getApproval(approvalId);
    if (!approval) throw new NotFound(`审批不存在：${approvalId}`);
    return approval;
  }

  async decide(
    approvalId: string,
    approved: boolean,
    reason = "",
  ): Promise<Approval> {
    const approval = this.get(approvalId);
    if (approval.status !== "pending") {
      throw new InvalidTransition(`审批已决策，不可重复决策：${approvalId}`);
    }
    const applied = this.approvals.decideApproval(
      approvalId,
      approved ? "approved" : "denied",
      reason,
    );
    if (!applied) {
      // 并发下被另一方抢先决策：与串行重复决策同口径 409。
      throw new InvalidTransition(`审批已决策，不可重复决策：${approvalId}`);
    }
    const decided = this.get(approvalId);
    const run = this.runs.getRun(approval.runId);
    if (!run) return decided;
    if (!approved) {
      this.chats.denyRun(run, reason);
      return decided;
    }
    if (run.source === "chat" || run.chatId) {
      await this.chats.resumeAfterApproval(run, decided);
    }
    return decided;
  }
}
