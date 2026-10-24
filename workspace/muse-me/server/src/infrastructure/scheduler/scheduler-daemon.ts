import { randomUUID } from "node:crypto";
import type {
  FeedStore,
  JobStore,
  NotificationStore,
  ScriptStore,
  ToolRegistryPort,
} from "../../domain/ports.js";
import { nextFire, parseIso, validateTrigger } from "../../domain/schedule.js";
import type { JobRecord, JobRunRecord } from "../../domain/types.js";
import { nowIso } from "../sqlite/database.js";

/**
 * 调度守护（移植 Python SchedulerDaemon）：进程内 setInterval 轮询 + 可手动 tick。
 *
 * 三类触发语义与 Python 现行版一致：
 * - time：next_fire_at 为正本，到点先滚动下一次再执行（错过合并为一次）；
 * - event：首次见到 job 只把当前精选 id 集记为基线，之后新增且命中关键词才触发；
 * - condition：边沿触发（假→真才执行），评估状态只存内存，重启后首次只建基线；
 *   另有冷却兜底（默认 60 秒，边沿被冷却吞掉不补发）。
 * 非法规格在 tick 时禁用并只通知一次；单 job 异常隔离，失败记录按
 * (job, 错误) 60 秒节流；awaiting_approval 不算失败，记 JobRun 并通知。
 * 执行走注入的 scriptRunner（组合根接 ScriptService.run，钉 script_version）。
 */

export interface ScriptRunOutcome {
  runId?: string | null;
  status: string;
  error?: string;
}

export type ScriptRunner = (
  job: JobRecord,
  params: Record<string, unknown>,
  entity: Record<string, unknown> | null,
) => ScriptRunOutcome;

export interface SchedulerDeps {
  jobs: JobStore;
  scripts: ScriptStore;
  feed: FeedStore;
  notifications: NotificationStore;
  tools: ToolRegistryPort;
  userId: string;
  runner: ScriptRunner;
  tickSeconds?: number;
  retryBackoffSeconds?: number;
  maxAttempts?: number;
  conditionCooldownSeconds?: number;
  /** 退避睡眠（秒）；测试注入空实现。默认用 Atomics.wait 真睡（同 Python 口径）。 */
  sleeper?: (seconds: number) => void;
}

const FAILURE_THROTTLE_SECONDS = 60.0;

const OPS: Record<string, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

function defaultSleeper(seconds: number): void {
  if (seconds <= 0) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, Math.round(seconds * 1000));
}

export class SchedulerDaemon {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly seenFeed = new Map<string, Set<string>>();
  private readonly conditionState = new Map<string, boolean>();
  private readonly lastConditionFire = new Map<string, number>();
  private readonly failureLast = new Map<string, number>();
  private lastDaemonErrorNote = 0;

  private readonly tickSeconds: number;
  private readonly retryBackoff: number;
  private readonly maxAttempts: number;
  private readonly conditionCooldown: number;
  private readonly sleeper: (seconds: number) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.tickSeconds = deps.tickSeconds ?? 1.0;
    this.retryBackoff = deps.retryBackoffSeconds ?? 0.5;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.conditionCooldown = deps.conditionCooldownSeconds ?? 60.0;
    this.sleeper = deps.sleeper ?? defaultSleeper;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // 守护不因单轮异常退出，但不许静默：写一条站内通知（60 秒节流防刷屏）。
        const nowTs = Date.now() / 1000;
        if (nowTs - this.lastDaemonErrorNote >= FAILURE_THROTTLE_SECONDS) {
          this.lastDaemonErrorNote = nowTs;
          try {
            this.notifyRaw(
              "调度守护异常",
              `调度线程一轮执行出错：${err instanceof Error ? err.message : String(err)}`,
            );
          } catch {
            // 通知本身失败不能拖垮守护
          }
        }
      }
    }, this.tickSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 处理全部 enabled 任务中已到触发条件的，返回本轮新建的 JobRun 列表。 */
  tick(now: Date = new Date()): JobRunRecord[] {
    const fired: JobRunRecord[] = [];
    for (const job of this.deps.jobs.listJobs(this.deps.userId)) {
      if (!job.enabled) continue;
      const invalid = validateTrigger(job);
      if (invalid !== null) {
        this.disableInvalid(job, invalid);
        continue;
      }
      try {
        fired.push(...this.maybeFire(job, now));
      } catch (err) {
        const failure = this.recordFailure(
          job,
          null,
          1,
          `scheduler: ${err instanceof Error ? err.message : String(err)}`,
          now,
        );
        if (failure) fired.push(failure);
      }
    }
    return fired;
  }

  /** 启用/暂停（同 Python set_enabled：启用时先 validate，非法则禁用并通知）。 */
  setEnabled(job: JobRecord, enabled: boolean, now: Date = new Date()): JobRecord {
    if (enabled) {
      const invalid = validateTrigger(job);
      if (invalid !== null) {
        this.disableInvalid(job, invalid);
        return job;
      }
    }
    job.enabled = enabled;
    if (enabled && job.triggerType === "time") {
      const due = parseIso(job.nextFireAt);
      if (!due || due.getTime() <= now.getTime()) {
        job.nextFireAt = nextFire(job, now);
      }
    }
    this.deps.jobs.updateJob(job);
    return job;
  }

  // ---------------- 触发判定 ----------------

  private maybeFire(job: JobRecord, now: Date): JobRunRecord[] {
    if (job.triggerType === "time") {
      const due = parseIso(job.nextFireAt);
      if (!due) {
        job.nextFireAt = nextFire(job, now);
        this.deps.jobs.updateJob(job);
        return [];
      }
      if (due.getTime() <= now.getTime()) {
        job.nextFireAt = nextFire(job, now);
        this.deps.jobs.updateJob(job);
        return [this.execute(job, { ...(job.params ?? {}) }, null, now)];
      }
      return [];
    }
    if (job.triggerType === "event") return this.checkEvent(job, now);
    if (job.triggerType === "condition") return this.checkCondition(job, now);
    return [];
  }

  private checkEvent(job: JobRecord, now: Date): JobRunRecord[] {
    const keyword = String(job.triggerSpec.keyword ?? "").toLowerCase();
    const items = this.deps.feed.listFeedItems(this.deps.userId, 200);
    const currentIds = new Set(items.map((item) => item.id));
    if (!this.seenFeed.has(job.id)) {
      this.seenFeed.set(job.id, currentIds); // 基线：既有条目不触发
      return [];
    }
    const seen = this.seenFeed.get(job.id)!;
    const fired: JobRunRecord[] = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const haystack = `${item.title} ${item.summary} ${item.topic}`.toLowerCase();
      if (!keyword || haystack.includes(keyword)) {
        const params = { ...(job.params ?? {}) };
        const entity = { ...(item.entities ?? {}) };
        if (entity.token) params.token ??= entity.token;
        fired.push(this.execute(job, params, entity, now));
      }
    }
    return fired;
  }

  private checkCondition(job: JobRecord, now: Date): JobRunRecord[] {
    const current = this.evalCondition(job.triggerSpec ?? {});
    if (!this.conditionState.has(job.id)) {
      this.conditionState.set(job.id, current); // 首次只建基线（重启防重复执行）
      return [];
    }
    const previous = this.conditionState.get(job.id)!;
    this.conditionState.set(job.id, current);
    if (!(current && !previous)) return [];
    const last = this.lastConditionFire.get(job.id) ?? 0;
    if (now.getTime() / 1000 - last < this.conditionCooldown) {
      return []; // 边沿被冷却吞掉（状态已更新，不补发）
    }
    this.lastConditionFire.set(job.id, now.getTime() / 1000);
    return [this.execute(job, { ...(job.params ?? {}) }, null, now)];
  }

  /**
   * condition 规格 {metric, op, threshold, args?}（同 Python _eval_condition）：
   * - "tool|field" → 任意工具取字段，args 从 spec.args 读；
   * - "SYM.field" → market.quote(symbol=SYM) 取 field；
   * - "SYM" → market.quote 取 price_usd。结果字段非数值一律 false。
   */
  private evalCondition(spec: Record<string, unknown>): boolean {
    const metric = String(spec.metric ?? "");
    const opText = String(spec.op ?? ">=");
    const threshold = Number(spec.threshold ?? 0) || 0;
    let tool: string;
    let field: string;
    let args: Record<string, unknown>;
    if (metric.includes("|")) {
      const [t, f] = metric.split("|", 2) as [string, string];
      tool = t;
      field = f;
      args = { ...((spec.args as Record<string, unknown> | undefined) ?? {}) };
    } else if (metric.includes(".")) {
      const dot = metric.indexOf(".");
      const symbol = metric.slice(0, dot);
      field = metric.slice(dot + 1);
      tool = "market.quote";
      args = { symbol: symbol.toUpperCase() };
    } else {
      tool = "market.quote";
      field = "price_usd";
      args = { symbol: metric.toUpperCase() };
    }
    const result = this.deps.tools.call(tool, args, "simulate");
    const value = result[field];
    if (typeof value !== "number") return false;
    return (OPS[opText] ?? OPS[">="]!)(value, threshold);
  }

  // ---------------- 执行与重试 ----------------

  private execute(
    job: JobRecord,
    params: Record<string, unknown>,
    entity: Record<string, unknown> | null,
    now: Date,
  ): JobRunRecord {
    const stamp = now.toISOString();
    const script = this.deps.scripts.getScript(job.scriptId);
    const version = job.scriptVersion ?? script?.currentVersion ?? null;
    let attempt = 0;
    let lastError = "";
    let last: JobRunRecord | null = null;
    while (attempt < this.maxAttempts) {
      attempt += 1;
      const jobRun: JobRunRecord = {
        id: randomUUID(),
        jobId: job.id,
        runId: null,
        scriptVersion: version,
        status: "running",
        attempt,
        error: "",
        startedAt: stamp,
        finishedAt: "",
      };
      this.deps.jobs.addJobRun(jobRun);
      let result: ScriptRunOutcome = { status: "failed" };
      let status: string;
      try {
        result = this.deps.runner(job, params, entity) ?? { status: "failed" };
        status = String(result.status || "done");
      } catch (err) {
        status = "failed";
        lastError = err instanceof Error ? err.message : String(err);
        result = { status: "failed" };
      }
      if (status === "awaiting_approval") {
        jobRun.status = "awaiting_approval";
        jobRun.runId = result.runId ?? null;
        jobRun.finishedAt = stamp;
        this.deps.jobs.addJobRun(jobRun);
        this.notify(
          job,
          "定时任务等你确认",
          `任务《${job.name}》已执行到敏感步骤，停在「待我确认」里等你拍板。`,
        );
        return jobRun;
      }
      if (status !== "failed") {
        jobRun.status = "done";
        jobRun.runId = result.runId ?? null;
        jobRun.finishedAt = stamp;
        this.deps.jobs.addJobRun(jobRun);
        return jobRun;
      }
      jobRun.status = "failed";
      jobRun.runId = result.runId ?? null;
      jobRun.error = lastError || String(result.error || "执行失败");
      jobRun.finishedAt = stamp;
      this.deps.jobs.addJobRun(jobRun);
      if (attempt < this.maxAttempts && this.retryBackoff > 0) {
        this.sleeper(this.retryBackoff * 2 ** (attempt - 1));
      }
      last = jobRun;
    }
    this.notify(
      job,
      "定时任务执行失败",
      `任务《${job.name}》重试 ${this.maxAttempts} 次仍失败：${lastError}`,
    );
    return last!;
  }

  private recordFailure(
    job: JobRecord,
    runId: string | null,
    attempt: number,
    error: string,
    now: Date,
  ): JobRunRecord | null {
    const key = `${job.id}\n${error}`;
    const last = this.failureLast.get(key);
    const ts = now.getTime() / 1000;
    if (last !== undefined && ts - last < FAILURE_THROTTLE_SECONDS) return null;
    this.failureLast.set(key, ts);
    const jobRun: JobRunRecord = {
      id: randomUUID(),
      jobId: job.id,
      runId,
      scriptVersion: null,
      status: "failed",
      attempt,
      error,
      startedAt: "",
      finishedAt: now.toISOString(),
    };
    this.deps.jobs.addJobRun(jobRun);
    return jobRun;
  }

  private disableInvalid(job: JobRecord, reason: string): void {
    job.enabled = false;
    this.deps.jobs.updateJob(job);
    this.notify(
      job,
      "定时任务已自动停用",
      `任务《${job.name}》的触发设置不合法（${reason}），已自动停用；改好设置后重新启用即可。`,
    );
  }

  private notify(job: JobRecord, title: string, body: string): void {
    this.deps.notifications.addNotification({
      id: randomUUID(),
      userId: job.userId,
      kind: "job",
      title,
      body,
      read: false,
      createdAt: nowIso(),
    });
  }

  private notifyRaw(title: string, body: string): void {
    this.deps.notifications.addNotification({
      id: randomUUID(),
      userId: this.deps.userId,
      kind: "job",
      title,
      body,
      read: false,
      createdAt: nowIso(),
    });
  }
}
