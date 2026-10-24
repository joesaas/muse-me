import { ApprovalExpired, InvalidTransition, NotFound } from "../domain/errors.js";
import type { ApprovalStore, RunStore } from "../domain/ports.js";
import type { Approval, GuardrailPolicy } from "../domain/types.js";
import { DEFAULT_GUARDRAIL_POLICY } from "../domain/types.js";
import type { ChatService } from "./chat.service.js";

/** 脚本运行续跑端口（组合根注入 ScriptService，避免审批服务直依赖引擎细节）。 */
export interface ScriptResumer {
  resume(runId: string): unknown;
}

/**
 * 审批用例：列表与决策。决策口径（评审定版）：
 * - 只允许对 pending 决策：先读分型（不存在 404 / 已决策 409），
 *   再经 store 的原子条件更新落决策，并发下只有一方生效；
 * - 批准后按 Run 来源续跑：有 script_id 走脚本引擎续跑（同 Python
 *   ApprovalService 的来源分发），其余 chat 来源经 ChatService 在原 Run 上续；
 * - 拒绝则把 Run 收口为 failed 并回一条助手消息。
 *
 * 审批超时（批次一，与 Python 同口径）：待审批超过政策 approval_timeout_minutes
 * 未决即过期——decide 时先判过期：审批置 rejected（reason=approval_timeout）、
 * 对应 run 置 failed、抛 ApprovalExpired（HTTP 410）；调度 tick 顺带调用
 * expireStale() 清扫过期 pending。
 */
export class ApprovalService {
  private readonly policy: GuardrailPolicy;

  constructor(
    private readonly approvals: ApprovalStore,
    private readonly runs: RunStore,
    private readonly chats: ChatService,
    private readonly userId: string,
    private readonly scripts?: ScriptResumer,
    policy?: GuardrailPolicy,
  ) {
    this.policy = policy ?? DEFAULT_GUARDRAIL_POLICY;
  }

  list(status?: string): Approval[] {
    return this.approvals.listApprovals(this.userId, status);
  }

  get(approvalId: string): Approval {
    const approval = this.approvals.getApproval(approvalId);
    if (!approval) throw new NotFound(`审批不存在：${approvalId}`);
    return approval;
  }

  /** 审批是否已超过超时（created_at 解析失败时视为已过期，从严）。 */
  private isExpired(approval: Approval, nowMs: number): boolean {
    const createdMs = Date.parse(approval.createdAt);
    if (!Number.isFinite(createdMs)) return true;
    return nowMs - createdMs > this.policy.approvalTimeoutMinutes * 60_000;
  }

  /** 把一条 pending 审批过期并收口 run；已被抢先决策时返回 false。 */
  private expireOne(approval: Approval): boolean {
    const applied = this.approvals.expireApproval(approval.id, "approval_timeout");
    if (!applied) return false;
    const run = this.runs.getRun(approval.runId);
    if (run && run.status === "awaiting_approval") {
      this.runs.addEvent(run.id, {
        type: "run_failed",
        payload: { reason: "approval_timeout", error: "审批已过期" },
      });
      this.runs.setRunError(run.id, "审批已过期");
      this.runs.updateRunStatus(run.id, "failed");
    }
    return true;
  }

  /** 清扫过期 pending 审批（供调度 tick 调用），返回过期条数。 */
  expireStale(nowMs: number = Date.now()): number {
    let count = 0;
    for (const approval of this.approvals.listApprovals(this.userId, "pending")) {
      if (this.isExpired(approval, nowMs) && this.expireOne(approval)) count++;
    }
    return count;
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
    if (this.isExpired(approval, Date.now())) {
      this.expireOne(approval);
      throw new ApprovalExpired("审批已过期");
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
    if (run.scriptId && this.scripts) {
      this.scripts.resume(run.id);
    } else if (run.source === "chat" || run.chatId) {
      await this.chats.resumeAfterApproval(run, decided);
    }
    return decided;
  }
}
