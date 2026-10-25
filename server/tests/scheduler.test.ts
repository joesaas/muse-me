import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationFailed } from "../src/domain/errors.js";
import { JobService } from "../src/application/job.service.js";
import type { ToolRegistryPort } from "../src/domain/ports.js";
import { nextFire, validateTrigger } from "../src/domain/schedule.js";
import type { JobRecord } from "../src/domain/types.js";
import { SchedulerDaemon } from "../src/infrastructure/scheduler/scheduler-daemon.js";
import { openDatabase } from "../src/infrastructure/sqlite/database.js";
import { SqliteFeedStore } from "../src/infrastructure/sqlite/feed.store.js";
import { SqliteJobStore } from "../src/infrastructure/sqlite/jobs.store.js";
import { SqliteNotificationStore } from "../src/infrastructure/sqlite/notifications.store.js";
import { SqliteScriptStore } from "../src/infrastructure/sqlite/scripts.store.js";

const USER = "demo-user";

describe("validate_trigger（移植 Python scheduler.validate_trigger）", () => {
  const job = (spec: Record<string, unknown>, type = "time") => ({
    triggerType: type,
    triggerSpec: spec,
  });

  it("cron_daily 格式/范围非法被拒", async () => {
    expect(validateTrigger(job({ cron_daily: "25:00" }))).toContain("超出范围");
    expect(validateTrigger(job({ cron_daily: "9:60" }))).toContain("超出范围");
    expect(validateTrigger(job({ cron_daily: "abc" }))).toContain("格式应为 HH:MM");
    expect(validateTrigger(job({ cron_daily: "8点半" }))).toContain("格式应为 HH:MM");
  });

  it("every_minutes < 1 或非整数被拒", async () => {
    expect(validateTrigger(job({ every_minutes: 0 }))).toContain("≥ 1");
    expect(validateTrigger(job({ every_minutes: -3 }))).toContain("≥ 1");
    expect(validateTrigger(job({ every_minutes: "x" }))).toContain("不是整数");
  });

  it("合法规格与非 time 类返回 null（同 Python：非 time 不验）", async () => {
    expect(validateTrigger(job({ cron_daily: "08:30" }))).toBeNull();
    expect(validateTrigger(job({ every_minutes: 30 }))).toBeNull();
    expect(validateTrigger(job({ keyword: "x" }, "event"))).toBeNull();
    expect(validateTrigger(job({}, "condition"))).toBeNull();
  });

  it("next_fire：every_minutes 以 next_fire_at 为锚滚动到严格晚于 now", async () => {
    const now = new Date("2026-10-24T10:00:00.000Z");
    const anchored = nextFire(
      { triggerType: "time", triggerSpec: { every_minutes: 30 }, nextFireAt: "2026-10-24T09:50:00.000Z" },
      now,
    );
    expect(anchored).toBe("2026-10-24T10:20:00.000Z");
    const fresh = nextFire(
      { triggerType: "time", triggerSpec: { every_minutes: 30 }, nextFireAt: "" },
      now,
    );
    expect(fresh).toBe("2026-10-24T10:30:00.000Z");
  });
});

function buildDaemonStack() {
  const db = openDatabase(":memory:");
  const jobs = new SqliteJobStore(db);
  const scripts = new SqliteScriptStore(db);
  const feed = new SqliteFeedStore(db);
  const notifications = new SqliteNotificationStore(db);
  const calls: Array<{ job: JobRecord; params: Record<string, unknown> }> = [];
  let price = 50;
  const tools: ToolRegistryPort = {
    call: async (name) =>
      name === "market.quote"
        ? { price_usd: price, source: "simulated", cost_usd: 0.001 }
        : {},
    getTool: () => undefined,
    hasTool: () => true,
  };
  const daemon = new SchedulerDaemon({
    jobs,
    scripts,
    feed,
    notifications,
    tools,
    userId: USER,
    runner: (job, params) => {
      calls.push({ job, params });
      return { runId: `run-${calls.length}`, status: "done" };
    },
    sleeper: async () => {},
  });
  const makeJob = (partial: Partial<JobRecord>): JobRecord => {
    const job: JobRecord = {
      id: randomUUID(),
      userId: USER,
      name: "测试任务",
      scriptId: "script-x",
      scriptVersion: null,
      triggerType: "time",
      triggerSpec: { every_minutes: 30 },
      params: {},
      enabled: true,
      nextFireAt: "",
      createdAt: new Date().toISOString(),
      ...partial,
    };
    jobs.createJob(job);
    return job;
  };
  return {
    db, jobs, scripts, feed, notifications, daemon, calls, makeJob,
    setPrice: (v: number) => { price = v; },
  };
}

let stack: ReturnType<typeof buildDaemonStack>;
afterEach(() => stack?.db.close());

describe("SchedulerDaemon 触发语义", () => {
  it("condition 边沿触发：首轮建基线、假→真触发一次、持续真不重复、假→真再触发", async () => {
    stack = buildDaemonStack();
    stack.makeJob({
      triggerType: "condition",
      triggerSpec: { metric: "ETH", op: ">", threshold: 100 },
    });
    const t0 = new Date("2026-10-24T10:00:00.000Z");
    const at = (sec: number) => new Date(t0.getTime() + sec * 1000);

    stack.setPrice(50);
    await stack.daemon.tick(at(0)); // 基线（假）
    expect(stack.calls).toHaveLength(0);

    stack.setPrice(150);
    await stack.daemon.tick(at(61)); // 假→真：触发
    expect(stack.calls).toHaveLength(1);

    await stack.daemon.tick(at(122)); // 持续真：不重复
    expect(stack.calls).toHaveLength(1);

    stack.setPrice(50);
    await stack.daemon.tick(at(183)); // 变假
    expect(stack.calls).toHaveLength(1);

    stack.setPrice(150);
    await stack.daemon.tick(at(244)); // 再假→真（已过 60 秒冷却）：再触发
    expect(stack.calls).toHaveLength(2);
  });

  it("condition 重启先建基线：进程重启后持续为真不误触发", async () => {
    stack = buildDaemonStack();
    stack.makeJob({
      triggerType: "condition",
      triggerSpec: { metric: "ETH", op: ">", threshold: 100 },
    });
    stack.setPrice(150); // 一直为真
    await stack.daemon.tick(new Date()); // 新 daemon 首轮只建基线
    expect(stack.calls).toHaveLength(0);
    await stack.daemon.tick(new Date(Date.now() + 120_000)); // 仍为真、无边沿
    expect(stack.calls).toHaveLength(0);
  });

  it("time 触发：到点执行一次并滚动 next_fire；错过多个周期只合并一次", async () => {
    stack = buildDaemonStack();
    const now = new Date("2026-10-24T10:00:00.000Z");
    const job = stack.makeJob({
      triggerType: "time",
      triggerSpec: { every_minutes: 10 },
      nextFireAt: "2026-10-24T08:00:00.000Z", // 已错过 12 个周期
    });
    const fired = await stack.daemon.tick(now);
    expect(stack.calls).toHaveLength(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.status).toBe("done");
    const after = stack.jobs.getJob(job.id);
    expect(new Date(after!.nextFireAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it("event 触发：首轮基线不触发，新增命中条目才触发且参数带入实体 token", async () => {
    stack = buildDaemonStack();
    stack.makeJob({
      triggerType: "event",
      triggerSpec: { keyword: "bonk" },
    });
    const base = {
      userId: USER, summary: "", source: "SeedNews", url: "", topic: "market",
      entities: {}, publishedAt: "", promptVersion: null,
      createdAt: new Date().toISOString(),
    };
    stack.feed.replaceFeedItems(USER, [
      { ...base, id: "a1", title: "比特币行情", entities: { token: "BTC" } },
    ]);
    await stack.daemon.tick(new Date()); // 基线
    expect(stack.calls).toHaveLength(0);

    stack.feed.replaceFeedItems(USER, [
      { ...base, id: "a1", title: "比特币行情", entities: { token: "BTC" } },
      {
        ...base, id: "b2", title: "BONK 交易量创新高", topic: "meme",
        entities: { token: "BONK", chain: "solana" },
      },
    ]);
    await stack.daemon.tick(new Date());
    expect(stack.calls).toHaveLength(1);
    expect(stack.calls[0]?.params.token).toBe("BONK");
  });

  it("非法 job 在 tick 时被禁用且只通知一次，不落 failure JobRun", async () => {
    stack = buildDaemonStack();
    const job = stack.makeJob({
      triggerType: "time",
      triggerSpec: { every_minutes: 0 },
      nextFireAt: "2026-10-24T08:00:00.000Z",
    });
    await stack.daemon.tick(new Date());
    await stack.daemon.tick(new Date());
    expect(stack.jobs.getJob(job.id)?.enabled).toBe(false);
    const notes = stack.notifications
      .listNotifications(USER)
      .filter((n) => n.title === "定时任务已自动停用");
    expect(notes).toHaveLength(1);
    expect(stack.jobs.listJobRuns(job.id)).toHaveLength(0);
  });

  it("awaiting_approval 不算失败：JobRun 记 awaiting_approval 并通知，不重试", async () => {
    stack = buildDaemonStack();
    const job = stack.makeJob({
      triggerType: "time",
      triggerSpec: { every_minutes: 10 },
      nextFireAt: "2026-10-24T08:00:00.000Z",
    });
    let runs = 0;
    const daemon = new SchedulerDaemon({
      jobs: stack.jobs,
      scripts: stack.scripts,
      feed: stack.feed,
      notifications: stack.notifications,
      tools: {
        call: async () => ({}),
        getTool: () => undefined,
        hasTool: () => true,
      },
      userId: USER,
      runner: () => {
        runs += 1;
        return { runId: "r-await", status: "awaiting_approval" };
      },
      sleeper: async () => {},
    });
    const fired = await daemon.tick(new Date("2026-10-24T10:00:00.000Z"));
    expect(runs).toBe(1);
    expect(fired[0]?.status).toBe("awaiting_approval");
    expect(fired[0]?.runId).toBe("r-await");
    expect(
      stack.notifications
        .listNotifications(USER)
        .some((n) => n.title === "定时任务等你确认"),
    ).toBe(true);
    void job;
  });
});

describe("JobService 创建校验", () => {
  it("非法 trigger 创建得 ValidationFailed 且不落库；合法创建 next_fire 在未来", async () => {
    stack = buildDaemonStack();
    const now = new Date().toISOString();
    stack.scripts.createScript({
      id: "script-x",
      userId: USER,
      name: "脚本 X",
      description: "",
      doc: { name: "脚本 X", steps: [{ tool: "meme.scan", args: { token: "BONK" } }] },
      currentVersion: 1,
      originChatId: null,
      originFeedItemId: null,
      createdAt: now,
      updatedAt: now,
    });
    const service = new JobService(stack.jobs, stack.scripts, USER);
    expect(() =>
      service.create({
        name: "坏任务",
        scriptId: "script-x",
        trigger: { type: "time", every_minutes: 0 },
      }),
    ).toThrow(ValidationFailed);
    expect(() =>
      service.create({
        name: "坏任务2",
        scriptId: "script-x",
        trigger: { type: "time", cron_daily: "24:00" },
      }),
    ).toThrow(ValidationFailed);
    expect(stack.jobs.listJobs(USER)).toHaveLength(0);

    const ok = service.create({
      name: "好任务",
      scriptId: "script-x",
      trigger: { type: "time", every_minutes: 45 },
    });
    expect(ok.enabled).toBe(true);
    expect(new Date(ok.nextFireAt).getTime()).toBeGreaterThan(Date.now());
    expect(stack.jobs.listJobs(USER)).toHaveLength(1);
  });
});
