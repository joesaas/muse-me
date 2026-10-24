import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltApp } from "../src/app.js";
import { makeConfig } from "../src/config.js";
import { ScriptEngine } from "../src/application/script-engine.js";
import type { ToolRegistryPort } from "../src/domain/ports.js";
import {
  DEFAULT_GUARDRAIL_POLICY,
  type GuardrailPolicy,
  type RunRecord,
  type ScriptDoc,
  type ScriptRecord,
} from "../src/domain/types.js";
import { LocalRuntime } from "../src/infrastructure/runtime/local-runtime.js";
import { SchedulerDaemon } from "../src/infrastructure/scheduler/scheduler-daemon.js";
import { openDatabase } from "../src/infrastructure/sqlite/database.js";
import { SqliteApprovalStore } from "../src/infrastructure/sqlite/approvals.store.js";
import { SqliteFeedStore } from "../src/infrastructure/sqlite/feed.store.js";
import { SqliteJobStore } from "../src/infrastructure/sqlite/jobs.store.js";
import { SqliteNotificationStore } from "../src/infrastructure/sqlite/notifications.store.js";
import { SqliteRunStore } from "../src/infrastructure/sqlite/runs.store.js";
import { SqliteScriptStore } from "../src/infrastructure/sqlite/scripts.store.js";
import { DEFAULT_NEWS_POOL } from "../src/infrastructure/tools/seed-news.js";
import { SimulatedToolRegistry } from "../src/infrastructure/tools/simulated-tools.js";

const USER = "demo-user";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** 记录调用的注册表包装：委托同一 SimulatedToolRegistry，证明两路走同一实现。 */
class RecordingRegistry implements ToolRegistryPort {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly inner: SimulatedToolRegistry) {}
  call(name: string, args: Record<string, unknown> = {}, mode = "simulate") {
    this.calls.push({ name, args: { ...args } });
    return this.inner.call(name, args, mode);
  }
  getTool(name: string) {
    return this.inner.getTool(name);
  }
  hasTool(name: string) {
    return this.inner.hasTool(name);
  }
}

function buildParityStack(policy: GuardrailPolicy) {
  const db = openDatabase(":memory:");
  const runs = new SqliteRunStore(db);
  const approvals = new SqliteApprovalStore(db);
  const scripts = new SqliteScriptStore(db);
  const feed = new SqliteFeedStore(db);
  const tools = new RecordingRegistry(new SimulatedToolRegistry(DEFAULT_NEWS_POOL));
  const runtime = new LocalRuntime(runs, undefined, tools, policy);
  const engine = new ScriptEngine(runs, approvals, scripts, feed, tools, policy, USER);
  return { db, runs, approvals, scripts, feed, tools, runtime, engine };
}

let parity: ReturnType<typeof buildParityStack> | undefined;
afterEach(() => {
  // 本文件后三个 describe 不用 parity；已关过的库不再重复关（node:sqlite 二次 close 抛错）。
  if (parity) {
    try {
      parity.db.close();
    } catch {
      // 已关则忽略
    }
    parity = undefined;
  }
});

async function runChat(prompt: string): Promise<{ runId: string; types: string[] }> {
  if (!parity) throw new Error("parity 未初始化");
  const now = new Date().toISOString();
  const run: RunRecord = {
    id: randomUUID(),
    userId: USER,
    chatId: null,
    scriptId: null,
    jobId: null,
    scene: "chat",
    source: "chat",
    status: "running",
    costUsd: 0,
    error: "",
    createdAt: now,
    updatedAt: now,
  };
  parity.runs.createRun(run);
  const session = parity.runtime.createSession(USER, "chat");
  const types: string[] = [];
  for await (const draft of parity.runtime.invoke(session.id, prompt, {
    scene: "chat",
    runId: run.id,
  })) {
    types.push(draft.type);
  }
  return { runId: run.id, types };
}

async function resumeChat(runId: string, step: number): Promise<string[]> {
  if (!parity) throw new Error("parity 未初始化");
  const session = parity.runtime.createSession(USER, "chat");
  const types: string[] = [];
  for await (const draft of parity.runtime.invoke(session.id, "", {
    resumeRunId: runId,
    approvedStep: step,
  })) {
    types.push(draft.type);
  }
  return types;
}

function makeMemeScript(): ScriptRecord {
  if (!parity) throw new Error("parity 未初始化");
  const now = new Date().toISOString();
  const doc: ScriptDoc = {
    name: "meme 买入",
    description: "查流动性 → 报价 → 模拟成交（无显式 gate，只测风险门位）。",
    params: [
      { key: "amount_usd", label: "金额", type: "number", default: 100 },
      { key: "token", label: "代币", type: "string", default: "BONK" },
    ],
    steps: [
      { tool: "meme.scan", args: { token: "${token}" }, save_as: "scan" },
      {
        tool: "dex.quote",
        args: { token: "${token}", amount_usd: "${amount_usd}" },
        save_as: "quote",
      },
      {
        tool: "dex.sim_swap",
        args: { token: "${token}", amount_usd: "${amount_usd}" },
        save_as: "swap",
      },
    ],
  };
  return parity.scripts.createScript({
    id: randomUUID(),
    userId: USER,
    name: "meme 买入",
    description: "",
    doc,
    currentVersion: 1,
    originChatId: null,
    originFeedItemId: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe("批次三-1：聊天与脚本走同一工具注册表、同一门位公式", () => {
  it("write=非 auto 时两路都在 dex.sim_swap 前挂起，且挂起前工具调用序列完全一致", async () => {
    parity = buildParityStack(DEFAULT_GUARDRAIL_POLICY);
    const chat = await runChat("买 BONK 这个 meme，100 美元");
    expect(chat.types).toContain("approval_required");
    expect(chat.types).not.toContain("run_done");
    expect(parity.runs.getRun(chat.runId)?.status).toBe("awaiting_approval");
    const chatCalls = [...parity.tools.calls];
    expect(chatCalls).toEqual([
      { name: "meme.scan", args: { token: "BONK" } },
      { name: "dex.quote", args: { token: "BONK", amount_usd: 100 } },
    ]);

    parity.tools.calls = [];
    const script = makeMemeScript();
    const first = parity.engine.runScript({ script });
    expect(first.status).toBe("awaiting_approval");
    expect(parity.tools.calls).toEqual(chatCalls);

    // 批准后续跑：两路都执行 swap，且 swap 参数一致。
    const resumedChatTypes = await resumeChat(chat.runId, 2);
    expect(resumedChatTypes).toContain("run_done");
    expect(parity.runs.getRun(chat.runId)?.status).toBe("done");
    // 聊天步成本口径不变：计划成本 0.002+0.002+0.003。
    expect(parity.runs.getRun(chat.runId)?.costUsd).toBeCloseTo(0.007, 6);
    const chatSwap = parity.tools.calls.filter((c) => c.name === "dex.sim_swap");
    expect(chatSwap).toEqual([
      { name: "dex.sim_swap", args: { token: "BONK", amount_usd: 100 } },
    ]);

    const pending = parity.approvals
      .listApprovals(USER)
      .find((a) => a.runId === first.run_id);
    expect(pending).toBeDefined();
    expect(parity.approvals.decideApproval(pending!.id, "approved", "")).toBe(true);
    const resumed = parity.engine.resumeScript(first.run_id);
    expect(resumed.status).toBe("done");
    const scriptSwap = resumed.steps.find((s) => s.tool === "dex.sim_swap");
    // 脚本步结果即注册表直调结果（同一实现、确定性同输入同输出）。
    expect(scriptSwap?.result).toEqual(
      new SimulatedToolRegistry(DEFAULT_NEWS_POOL).call(
        "dex.sim_swap",
        { token: "BONK", amount_usd: 100 },
        "simulate",
      ),
    );
  });

  it("write=auto 时两路都不挂审批：聊天与脚本均直达 done", async () => {
    const autoPolicy: GuardrailPolicy = {
      ...DEFAULT_GUARDRAIL_POLICY,
      riskLevels: { read: "auto", write: "auto", irreversible: "single_approval" },
    };
    parity = buildParityStack(autoPolicy);
    const chat = await runChat("买 BONK 这个 meme，100 美元");
    expect(chat.types).not.toContain("approval_required");
    expect(chat.types).toContain("run_done");
    expect(parity.runs.getRun(chat.runId)?.status).toBe("done");

    const script = makeMemeScript();
    const result = parity.engine.runScript({ script });
    expect(result.status).toBe("done");
    expect(result.steps.map((s) => s.tool)).toEqual([
      "meme.scan",
      "dex.quote",
      "dex.sim_swap",
    ]);
    expect(
      parity.approvals.listApprovals(USER).filter((a) => a.runId === result.run_id),
    ).toHaveLength(0);
  });
});

describe("批次三-2：调度退避不再阻塞事件循环", () => {
  it("失败 job 处于 0.3s 退避等待时，真 Fastify 服务的 GET /health 在 200ms 内返回", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "museme-batch3-"));
    const built: BuiltApp = buildApp(
      makeConfig({
        dbPath: path.join(dir, "server.db"),
        password: "test-pw",
        startScheduler: false,
      }),
    );
    const db = openDatabase(":memory:");
    try {
      const jobs = new SqliteJobStore(db);
      const scripts = new SqliteScriptStore(db);
      const feed = new SqliteFeedStore(db);
      const notifications = new SqliteNotificationStore(db);
      const daemon = new SchedulerDaemon({
        jobs,
        scripts,
        feed,
        notifications,
        tools: { call: () => ({}), getTool: () => undefined, hasTool: () => true },
        userId: USER,
        runner: () => ({ runId: null, status: "failed", error: "boom" }),
        retryBackoffSeconds: 0.3,
        maxAttempts: 3,
      });
      jobs.createJob({
        id: randomUUID(),
        userId: USER,
        name: "必失败任务",
        scriptId: "script-x",
        scriptVersion: null,
        triggerType: "time",
        triggerSpec: { every_minutes: 30 },
        params: {},
        enabled: true,
        nextFireAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: new Date().toISOString(),
      });

      await built.app.listen({ host: "127.0.0.1", port: 0 });
      const address = built.app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      // tick 不 await：它将在第一次失败后进入 0.3s 异步退避。
      const tickPromise = daemon.tick(new Date());
      let tickDone = false;
      void tickPromise.then(() => {
        tickDone = true;
      });
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const elapsedMs = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(200);
      expect(tickDone).toBe(false);
      const fired = await tickPromise;
      expect(fired[fired.length - 1]?.status).toBe("failed");
    } finally {
      await built.close();
      db.close();
    }
  });
});

describe("批次三-3：护栏来源可观测", () => {
  it("file 来源：启动日志与 /api/agent/health 均含 guardrailSource=file 与政策路径", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), "museme-batch3-health-"));
    const built: BuiltApp = buildApp(
      makeConfig({
        dbPath: path.join(dir, "server.db"),
        password: "test-pw",
        startScheduler: false,
        harnessRoot: path.join(REPO_ROOT, "harness"),
      }),
    );
    try {
      const logLines = spy.mock.calls.map((c) => String(c[0]));
      expect(logLines.some((l) => l.includes("guardrailSource=file"))).toBe(true);
      expect(
        logLines.some((l) => l.includes(path.join("harness", "guardrails", "policy.md"))),
      ).toBe(true);

      const login = await built.app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "test-pw" },
      });
      const cookie = String(
        (Array.isArray(login.headers["set-cookie"])
          ? login.headers["set-cookie"][0]
          : login.headers["set-cookie"]) ?? "",
      ).split(";", 1)[0]!;
      const res = await built.app.inject({
        method: "GET",
        url: "/api/agent/health",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.guardrailSource).toBe("file");
      expect(String(body.guardrailPolicyPath)).toContain(
        path.join("harness", "guardrails", "policy.md"),
      );
      // 原有健康字段不受影响。
      expect(body.runtimeMode).toBe("local");
    } finally {
      spy.mockRestore();
      await built.close();
    }
  });

  it("fail-closed 时 health 如实写 fail-closed，不伪装成 file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "museme-batch3-failclosed-"));
    const built: BuiltApp = buildApp(
      makeConfig({
        dbPath: path.join(dir, "server.db"),
        password: "test-pw",
        startScheduler: false,
        harnessRoot: path.join(dir, "no-such-harness"),
      }),
    );
    try {
      const login = await built.app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "test-pw" },
      });
      const cookie = String(
        (Array.isArray(login.headers["set-cookie"])
          ? login.headers["set-cookie"][0]
          : login.headers["set-cookie"]) ?? "",
      ).split(";", 1)[0]!;
      const res = await built.app.inject({
        method: "GET",
        url: "/api/agent/health",
        headers: { cookie },
      });
      const body = res.json() as Record<string, unknown>;
      expect(body.guardrailSource).toBe("fail-closed");
      expect(body.guardrailSource).not.toBe("file");
    } finally {
      await built.close();
    }
  });
});
