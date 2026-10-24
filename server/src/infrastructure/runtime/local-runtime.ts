import { randomUUID } from "node:crypto";
import { InvalidTransition } from "../../domain/errors.js";
import type { InvokeContext, RunStore, RuntimePort } from "../../domain/ports.js";
import { assertRunTransition, isTerminalRunStatus } from "../../domain/run-state.js";
import type {
  RunEventDraft,
  RunEventRecord,
  RunRecord,
  SessionInfo,
} from "../../domain/types.js";
import { nowIso } from "../sqlite/database.js";
import {
  buildPlan,
  runSimulatedTool,
  type PlanStep,
  type SimulatedPlan,
} from "./simulated.js";
import { pollStoreEvents } from "./store-event-stream.js";

interface SuspendedRun {
  plan: SimulatedPlan;
  /** 挂起步（待审批）的下标；批准后续跑从这一步开始执行。 */
  nextIndex: number;
  spentUsd: number;
}

/**
 * RuntimePort 的本地实现：进程内确定性模拟运行时（simulated）。
 * 事件序列与 Python 版一致：plan_created → step_started / tool_called /
 * step_done …敏感步先落 approval_required 并把 Run 置 awaiting_approval 后
 * 结束本次流；审批通过后由应用层以 resumeRunId 再次 invoke 续跑。
 * 事件与状态都经 RunStore 落库，轨迹即可回放的事实。
 */
export class LocalRuntime implements RuntimePort {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly suspended = new Map<string, SuspendedRun>();
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly runs: RunStore) {}

  createSession(userId: string, scene = "chat"): SessionInfo {
    const session: SessionInfo = {
      id: randomUUID(),
      userId,
      scene,
      createdAt: nowIso(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async *invoke(
    sessionId: string,
    prompt: string,
    ctx: InvokeContext = {},
  ): AsyncIterable<RunEventDraft> {
    if (ctx.resumeRunId) {
      yield* this.resume(ctx.resumeRunId, ctx.approvedStep);
      return;
    }
    const session = this.sessions.get(sessionId);
    const scene = ctx.scene ?? session?.scene ?? "chat";
    const runId = ctx.runId;
    if (!runId) {
      throw new InvalidTransition("LocalRuntime.invoke 需要 ctx.runId（Run 由应用层先建）");
    }
    const plan = buildPlan(scene, prompt);
    this.active.add(runId);
    try {
      yield this.emit(runId, "plan_created", {
        goal: plan.goal,
        scene: plan.scene,
        steps: plan.steps.length,
        planner: "local-simulated",
        simulated: true,
        amount_defaulted: plan.amountDefaulted,
      });
      yield* this.executeSteps(runId, plan, 0, 0, -1);
    } finally {
      this.active.delete(runId);
    }
  }

  /**
   * 从 fromIndex 开始执行计划步。skipApprovalIndex 是「刚被批准的那一步」下标
   * （续跑首步），该步不再重复挂起；其后若再遇敏感步仍会再次挂起。
   */
  private async *executeSteps(
    runId: string,
    plan: SimulatedPlan,
    fromIndex: number,
    spentBefore: number,
    skipApprovalIndex: number,
  ): AsyncIterable<RunEventDraft> {
    let spent = spentBefore;
    for (let i = fromIndex; i < plan.steps.length; i++) {
      if (this.cancelled.has(runId)) {
        this.transition(runId, "cancelled");
        return;
      }
      const stepDef = plan.steps[i];
      if (stepDef.needsApproval && i !== skipApprovalIndex) {
        yield this.emit(runId, "approval_required", {
          step: String(i),
          label: stepDef.label,
          tool: stepDef.tool,
        });
        this.suspended.set(runId, { plan, nextIndex: i, spentUsd: spent });
        this.transition(runId, "awaiting_approval");
        return;
      }
      yield* this.executeStep(runId, i, stepDef);
      spent += stepDef.costUsd;
    }
    yield this.emit(runId, "run_done", {
      spent_usd: Number(spent.toFixed(6)),
      simulated: true,
    });
    this.transition(runId, "done");
  }

  private async *executeStep(
    runId: string,
    index: number,
    stepDef: PlanStep,
  ): AsyncIterable<RunEventDraft> {
    const path = String(index);
    yield this.emit(runId, "step_started", { step: path, kind: "tool", tool: stepDef.tool });
    yield this.emit(runId, "tool_called", {
      step: path,
      tool: stepDef.tool,
      args: stepDef.args,
    });
    runSimulatedTool(stepDef.tool, stepDef.args);
    this.runs.addRunCost(runId, stepDef.costUsd);
    yield this.emit(runId, "step_done", {
      step: path,
      tool: stepDef.tool,
      save_as: stepDef.saveAs ?? null,
      cost_usd: stepDef.costUsd,
    });
  }

  private async *resume(
    runId: string,
    approvedStep: number | undefined,
  ): AsyncIterable<RunEventDraft> {
    const state = this.suspended.get(runId);
    if (!state) {
      throw new InvalidTransition(
        `Run ${runId} 的挂起状态不存在（服务可能已重启），无法续跑，请重新发起`,
      );
    }
    const stepIndex = approvedStep ?? state.nextIndex;
    if (stepIndex !== state.nextIndex) {
      throw new InvalidTransition(
        `批准的步 ${stepIndex} 与挂起步 ${state.nextIndex} 不一致，拒绝续跑`,
      );
    }
    this.suspended.delete(runId);
    this.transition(runId, "running");
    this.active.add(runId);
    try {
      yield* this.executeSteps(runId, state.plan, state.nextIndex, state.spentUsd, state.nextIndex);
    } finally {
      this.active.delete(runId);
    }
  }

  async *streamEvents(runId: string, afterSeq = 0): AsyncIterable<RunEventRecord> {
    yield* pollStoreEvents(this.runs, runId, afterSeq);
  }

  async cancel(runId: string): Promise<boolean> {
    if (this.active.has(runId)) {
      this.cancelled.add(runId);
      return true;
    }
    if (this.suspended.delete(runId)) {
      return true;
    }
    return false;
  }

  async getTrace(runId: string): Promise<RunEventRecord[]> {
    return this.runs.listEvents(runId, 0);
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      status: "ok",
      runtime: "local",
      simulated: true,
      sessions: this.sessions.size,
      suspended_runs: this.suspended.size,
    };
  }

  // ---------------- 内部 ----------------

  private emit(runId: string, type: string, payload: Record<string, unknown>): RunEventRecord {
    return this.runs.addEvent(runId, { type, payload });
  }

  private transition(runId: string, target: RunRecord["status"]): void {
    const run = this.runs.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) return;
    assertRunTransition(run.status, target);
    this.runs.updateRunStatus(runId, target);
  }
}
