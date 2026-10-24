import { randomUUID } from "node:crypto";
import { InvalidTransition } from "../../domain/errors.js";
import type {
  InvokeContext,
  RunSnapshotStore,
  RunStore,
  RuntimePort,
  ToolRegistryPort,
} from "../../domain/ports.js";
import { assertRunTransition, isTerminalRunStatus } from "../../domain/run-state.js";
import {
  actionForRisk,
  DEFAULT_GUARDRAIL_POLICY,
  TOOL_RISKS,
  type ChatPlanSnapshot,
  type GuardrailPolicy,
  type RunEventDraft,
  type RunEventRecord,
  type RunRecord,
  type SessionInfo,
} from "../../domain/types.js";
import { nowIso } from "../sqlite/database.js";
import { buildPlan, type PlanStep, type SimulatedPlan } from "./simulated.js";
import { SimulatedToolRegistry } from "../tools/simulated-tools.js";
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
 *
 * 二期：挂起时把续跑快照（计划/挂起步/已花费）同步落 RunSnapshotStore，
 * 进程内存 Map 降为缓存——server 重启后 awaiting 的 Run 仍可从快照重建续跑。
 *
 * 批次三（ARCH-2/BE-6）：工具单实现——执行改走注入的 ToolRegistryPort
 * （组合根传 SimulatedToolRegistry，与脚本引擎同一注册表），不再用
 * simulated.ts 的 runSimulatedTool；门位改按 TOOL_RISKS + actionForRisk
 * 推导（与脚本引擎 gateSteps 同口径），不再读计划自带的 needsApproval。
 * tools/policy 省略时回退默认注册表 + DEFAULT 政策（仅兼容旧的无参测试
 * 构造；组合根永远显式注入真实政策，运行政策不取自默认值）。
 */
export class LocalRuntime implements RuntimePort {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly suspended = new Map<string, SuspendedRun>();
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly runs: RunStore,
    private readonly snapshots?: RunSnapshotStore,
    private readonly tools: ToolRegistryPort = new SimulatedToolRegistry([]),
    private readonly policy: GuardrailPolicy = DEFAULT_GUARDRAIL_POLICY,
  ) {}

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
        this.snapshots?.deleteSnapshot(runId);
        this.transition(runId, "cancelled");
        return;
      }
      const stepDef = plan.steps[i];
      if (this.requiresApproval(stepDef) && i !== skipApprovalIndex) {
        yield this.emit(runId, "approval_required", {
          step: String(i),
          label: stepDef.label,
          tool: stepDef.tool,
        });
        const state: SuspendedRun = { plan, nextIndex: i, spentUsd: spent };
        this.suspended.set(runId, state);
        this.persistSnapshot(runId, state);
        this.transition(runId, "awaiting_approval");
        return;
      }
      yield* this.executeStep(runId, i, stepDef);
      spent += stepDef.costUsd;
    }
    this.snapshots?.deleteSnapshot(runId);
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
    // 单实现：与脚本引擎同一注册表、同一 mode="simulate"。
    // 步成本口径保持不变：仍记计划自带的 stepDef.costUsd，不改用
    // 注册表结果里的 cost_usd（两者在 Aave 步上并不相等，见评审 BE-6 备注）。
    this.tools.call(stepDef.tool, stepDef.args, "simulate");
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
    const state = this.suspended.get(runId) ?? this.loadSnapshot(runId);
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
      this.snapshots?.deleteSnapshot(runId);
      return true;
    }
    if (this.snapshots?.getSnapshot(runId)) {
      this.snapshots.deleteSnapshot(runId);
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

  /**
   * 门位推导（与 ScriptEngine.gateSteps 同口径）：
   *   risk = TOOL_RISKS[tool] ?? "write"（查不到从严回退 write）
   *   action = actionForRisk(policy, risk)
   *   挂审批 ⟺ action !== "auto"
   * 计划自带的 needsApproval 至此不再作为门位依据（计划形状不变，仅不读它）。
   */
  private requiresApproval(stepDef: PlanStep): boolean {
    const risk = TOOL_RISKS[stepDef.tool] ?? "write";
    return actionForRisk(this.policy, risk) !== "auto";
  }

  // ---------------- 内部 ----------------

  /** 挂起快照落库：{plan, nextIndex, spentUsd}，与内存 Map 同步写。 */
  private persistSnapshot(runId: string, state: SuspendedRun): void {
    this.snapshots?.saveSnapshot(runId, "chat_plan", {
      plan: state.plan,
      nextIndex: state.nextIndex,
      spentUsd: state.spentUsd,
    } satisfies ChatPlanSnapshot as unknown as Record<string, unknown>);
  }

  /** 内存无挂起态时从快照重建（server 重启后续跑的路径），并回填内存缓存。 */
  private loadSnapshot(runId: string): SuspendedRun | undefined {
    const snap = this.snapshots?.getSnapshot(runId);
    if (!snap || snap.kind !== "chat_plan") return undefined;
    const payload = snap.payload as unknown as ChatPlanSnapshot;
    if (!payload.plan || typeof payload.nextIndex !== "number") return undefined;
    const state: SuspendedRun = {
      plan: payload.plan as SimulatedPlan,
      nextIndex: payload.nextIndex,
      spentUsd: Number(payload.spentUsd ?? 0),
    };
    this.suspended.set(runId, state);
    return state;
  }

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
