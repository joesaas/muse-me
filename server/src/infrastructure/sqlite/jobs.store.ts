import type { DatabaseSync } from "node:sqlite";
import type { JobStore } from "../../domain/ports.js";
import type { JobRecord, JobRunRecord } from "../../domain/types.js";
import { parseJsonObject } from "./json.js";

interface JobRow {
  id: string;
  user_id: string;
  name: string;
  script_id: string;
  script_version: number | null;
  trigger_type: string;
  trigger_spec: string;
  params: string;
  enabled: number;
  next_fire_at: string;
  created_at: string;
}

interface JobRunRow {
  id: string;
  job_id: string;
  run_id: string | null;
  script_version: number | null;
  status: string;
  attempt: number;
  error: string;
  started_at: string;
  finished_at: string;
}

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scriptId: row.script_id,
    scriptVersion: row.script_version,
    triggerType: row.trigger_type,
    triggerSpec: parseJsonObject(row.trigger_spec),
    params: parseJsonObject(row.params),
    enabled: Boolean(row.enabled),
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
  };
}

function toJobRun(row: JobRunRow): JobRunRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    runId: row.run_id,
    scriptVersion: row.script_version,
    status: row.status,
    attempt: row.attempt,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** JobStore 的 SQLite 实现：jobs + job_runs（addJobRun 为 INSERT OR REPLACE，同 Python）。 */
export class SqliteJobStore implements JobStore {
  constructor(private readonly db: DatabaseSync) {}

  createJob(job: JobRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO jobs
           (id, user_id, name, script_id, script_version, trigger_type,
            trigger_spec, params, enabled, next_fire_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id, job.userId, job.name, job.scriptId, job.scriptVersion,
        job.triggerType, JSON.stringify(job.triggerSpec ?? {}),
        JSON.stringify(job.params ?? {}), job.enabled ? 1 : 0,
        job.nextFireAt, job.createdAt,
      );
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as unknown as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  listJobs(userId: string): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at")
      .all(userId) as unknown as JobRow[];
    return rows.map(toJob);
  }

  updateJob(job: JobRecord): void {
    this.db
      .prepare(
        `UPDATE jobs SET name = ?, script_id = ?, script_version = ?,
                trigger_type = ?, trigger_spec = ?, params = ?, enabled = ?,
                next_fire_at = ? WHERE id = ?`,
      )
      .run(
        job.name, job.scriptId, job.scriptVersion, job.triggerType,
        JSON.stringify(job.triggerSpec ?? {}), JSON.stringify(job.params ?? {}),
        job.enabled ? 1 : 0, job.nextFireAt, job.id,
      );
  }

  addJobRun(jobRun: JobRunRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO job_runs
           (id, job_id, run_id, script_version, status, attempt, error,
            started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobRun.id, jobRun.jobId, jobRun.runId, jobRun.scriptVersion,
        jobRun.status, jobRun.attempt, jobRun.error, jobRun.startedAt,
        jobRun.finishedAt,
      );
  }

  listJobRuns(jobId: string): JobRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at, rowid")
      .all(jobId) as unknown as JobRunRow[];
    return rows.map(toJobRun);
  }
}
