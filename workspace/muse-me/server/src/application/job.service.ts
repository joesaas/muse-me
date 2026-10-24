import { randomUUID } from "node:crypto";
import { NotFound, ValidationFailed } from "../domain/errors.js";
import type { JobStore, ScriptStore } from "../domain/ports.js";
import { nextFire, parseIso, validateTrigger } from "../domain/schedule.js";
import type { JobRecord } from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";

/** 定时任务用例（同 Python JobService）：创建先 validate_trigger，非法 400 不落库。 */
export class JobService {
  constructor(
    private readonly jobs: JobStore,
    private readonly scripts: ScriptStore,
    private readonly userId: string,
  ) {}

  list(): JobRecord[] {
    return this.jobs.listJobs(this.userId);
  }

  get(jobId: string): JobRecord {
    const job = this.jobs.getJob(jobId);
    if (!job) throw new NotFound(`定时任务不存在：${jobId}`);
    return job;
  }

  create(input: {
    name: string;
    scriptId: string;
    trigger: Record<string, unknown>;
    params?: Record<string, unknown>;
    scriptVersion?: number | null;
  }): JobRecord {
    if (!this.scripts.getScript(input.scriptId)) {
      throw new NotFound(`脚本不存在：${input.scriptId}`);
    }
    const trigger = { ...(input.trigger ?? { type: "time", every_minutes: 60 }) };
    const triggerType = String(trigger.type ?? "time");
    delete trigger.type;
    const job: JobRecord = {
      id: randomUUID(),
      userId: this.userId,
      name: input.name || "定时任务",
      scriptId: input.scriptId,
      scriptVersion: input.scriptVersion ?? null,
      triggerType,
      triggerSpec: trigger,
      params: { ...(input.params ?? {}) },
      enabled: true,
      nextFireAt: "",
      createdAt: nowIso(),
    };
    // 创建时先校验触发规格（scheduler.validate_trigger），非法不落库，
    // 不等调度 tick 时才爆（与 Python JobService.create 同口径）。
    const problem = validateTrigger(job);
    if (problem !== null) {
      throw new ValidationFailed(`触发条件不合法：${problem}`);
    }
    job.nextFireAt = nextFire(job, new Date());
    this.jobs.createJob(job);
    return job;
  }

  toggle(jobId: string): JobRecord {
    const job = this.get(jobId);
    job.enabled = !job.enabled;
    if (job.enabled && job.triggerType === "time") {
      const due = parseIso(job.nextFireAt);
      const now = new Date();
      if (!due || due.getTime() <= now.getTime()) {
        job.nextFireAt = nextFire(job, now);
      }
    }
    this.jobs.updateJob(job);
    return job;
  }

  lastStatus(jobId: string): string {
    const runs = this.jobs.listJobRuns(jobId);
    return runs.length > 0 ? runs[runs.length - 1]!.status : "";
  }
}
