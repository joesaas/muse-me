import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  GuardrailDenied,
  InvalidTransition,
  ValidationFailed,
} from "../src/domain/errors.js";
import { ScriptEngine } from "../src/application/script-engine.js";
import { ScriptService } from "../src/application/script.service.js";
import { DEFAULT_GUARDRAIL_POLICY, type ScriptDoc, type ScriptRecord } from "../src/domain/types.js";
import { openDatabase } from "../src/infrastructure/sqlite/database.js";
import { SqliteApprovalStore } from "../src/infrastructure/sqlite/approvals.store.js";
import { SqliteFeedStore } from "../src/infrastructure/sqlite/feed.store.js";
import { SqliteRunStore } from "../src/infrastructure/sqlite/runs.store.js";
import { SqliteScriptStore } from "../src/infrastructure/sqlite/scripts.store.js";
import { DEFAULT_NEWS_POOL } from "../src/infrastructure/tools/seed-news.js";
import { SimulatedToolRegistry } from "../src/infrastructure/tools/simulated-tools.js";

const USER = "demo-user";

function buildStack() {
  const db: DatabaseSync = openDatabase(":memory:");
  const runs = new SqliteRunStore(db);
  const approvals = new SqliteApprovalStore(db);
  const scripts = new SqliteScriptStore(db);
  const feed = new SqliteFeedStore(db);
  const tools = new SimulatedToolRegistry(DEFAULT_NEWS_POOL);
  const engine = new ScriptEngine(
    runs, approvals, scripts, feed, tools, DEFAULT_GUARDRAIL_POLICY, USER,
  );
  const service = new ScriptService(engine, scripts, feed, USER);
  return { db, runs, approvals, scripts, feed, tools, engine, service };
}

let stack: ReturnType<typeof buildStack>;
afterEach(() => stack?.db.close());

function makeScript(doc: ScriptDoc): ScriptRecord {
  const now = new Date().toISOString();
  return stack.scripts.createScript({
    id: randomUUID(),
    userId: USER,
    name: String(doc.name),
    description: String(doc.description ?? ""),
    doc,
    currentVersion: 1,
    originChatId: null,
    originFeedItemId: null,
    createdAt: now,
    updatedAt: now,
  });
}

const MEME_DOC: ScriptDoc = {
  name: "新闻驱动 meme 买入",
  description: "查流动性 → 报价 → 审批后模拟成交。",
  entity: { token: "BONK", chain: "solana" },
  params: [
    { key: "amount_usd", label: "买入金额（美元）", type: "number", default: 100 },
    { key: "token", label: "代币", type: "string", default: "${entity.token}" },
  ],
  steps: [
    { tool: "meme.scan", args: { token: "${token}" }, save_as: "scan" },
    {
      tool: "dex.quote",
      args: { token: "${token}", amount_usd: "${amount_usd}" },
      save_as: "quote",
    },
  ],
  requires_approval_before_step: 2,
  final_step: {
    tool: "dex.sim_swap",
    args: { token: "${token}", amount_usd: "${amount_usd}" },
  },
};

describe("脚本引擎：金额护栏（评审必修口径）", () => {
  it("引号金额拦截：string 参数喂入 amount_usd，先数值化再比上限，超限 GuardrailDenied 且轨迹留痕", () => {
    stack = buildStack();
    const script = makeScript({
      name: "引号金额脚本",
      params: [{ key: "amt", label: "金额", type: "string", default: "2000" }],
      steps: [],
      final_step: {
        tool: "dex.sim_swap",
        args: { token: "BONK", amount_usd: "${amt}" },
      },
    });
    expect(() => stack.service.run(script.id)).toThrow(GuardrailDenied);
    const run = stack.runs.listRuns(USER)[0]!;
    expect(run.status).toBe("failed");
    const failed = stack.runs
      .listEvents(run.id, 0)
      .find((e) => e.type === "run_failed");
    expect(failed?.payload.reason).toBe("guardrail");
    expect(String(failed?.payload.error)).toContain("超过模拟上限");
  });

  it("非数值字符串金额：数值化失败即护栏拒绝（不是把字符串当 0 放行）", () => {
    stack = buildStack();
    const script = makeScript({
      name: "乱码金额脚本",
      params: [{ key: "amt", label: "金额", type: "string", default: "abc" }],
      steps: [],
      final_step: {
        tool: "dex.sim_swap",
        args: { token: "BONK", amount_usd: "${amt}" },
      },
    });
    expect(() => stack.service.run(script.id)).toThrow(GuardrailDenied);
    const run = stack.runs.listRuns(USER)[0]!;
    expect(run.status).toBe("failed");
    const failed = stack.runs
      .listEvents(run.id, 0)
      .find((e) => e.type === "run_failed");
    expect(String(failed?.payload.error)).toContain("需要数字");
  });

  it("限额内的引号金额被数值化后正常走到门位挂起，批准后续跑完成", () => {
    stack = buildStack();
    const script = makeScript({
      name: "限额内引号金额",
      params: [{ key: "amt", label: "金额", type: "string", default: "500" }],
      steps: [],
      final_step: {
        tool: "dex.sim_swap",
        args: { token: "BONK", amount_usd: "${amt}" },
      },
    });
    const first = stack.service.run(script.id);
    expect(first.status).toBe("awaiting_approval");
    const pending = stack.approvals.listApprovals(USER, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.amountUsd).toBe(500);

    // 注：不对 pending 中的 run 直接调 resume——Python resume_script 会先置
    // RUNNING 再在门位返回 awaiting（状态留在 running），该路径经 API 不可达
    // （审批 decide 永远先于 resume），此处只走真实链路：先决策再续跑。
    stack.approvals.decideApproval(pending[0]!.id, "approved", "");
    const done = stack.service.resume(first.run_id);
    expect(done.status).toBe("done");
    expect(stack.runs.getRun(first.run_id)?.status).toBe("done");
  });
});

describe("脚本引擎：DSL 校验", () => {
  it("插值只许一级点号：${quote.price.usd} 被拒", () => {
    stack = buildStack();
    expect(() =>
      stack.engine.validateScript({
        name: "坏插值",
        steps: [
          { tool: "meme.scan", args: { token: "BONK" }, save_as: "scan" },
          { tool: "dex.quote", args: { token: "${scan.price.usd}" } },
        ],
      }),
    ).toThrow(ValidationFailed);
  });

  it("引用未先行定义的名字被拒（后步的 save_as 不能被前步引用）", () => {
    stack = buildStack();
    expect(() =>
      stack.engine.validateScript({
        name: "前向引用",
        steps: [
          { tool: "dex.quote", args: { token: "${q}", amount_usd: 1 } },
          { tool: "meme.scan", args: { token: "BONK" }, save_as: "q" },
        ],
      }),
    ).toThrow(/引用了未定义的名字/);
  });

  it("未闭合插值与越界 gate 被拒", () => {
    stack = buildStack();
    expect(() =>
      stack.engine.validateScript({
        name: "未闭合",
        params: [{ key: "token", type: "string" }],
        steps: [{ tool: "meme.scan", args: { token: "${token" } }],
      }),
    ).toThrow(ValidationFailed);
    expect(() =>
      stack.engine.validateScript({
        name: "越界门位",
        steps: [{ tool: "meme.scan", args: { token: "BONK" } }],
        requires_approval_before_step: 5,
      }),
    ).toThrow(ValidationFailed);
  });
});

describe("脚本引擎：试运行与版本钉住", () => {
  it("trial 不建审批不挂起，全程模拟跑完并产出 facts/steps", () => {
    stack = buildStack();
    const script = makeScript(MEME_DOC);
    const result = stack.service.trial(script.id);
    expect(result.status).toBe("done");
    expect(result.steps).toHaveLength(3);
    expect(Object.keys(result.facts).sort()).toEqual(["quote", "scan"]);
    expect(result.spent_usd).toBeGreaterThan(0);
    expect(stack.approvals.listApprovals(USER)).toHaveLength(0);
  });

  it("正式运行停在门位；resume 前置：非 awaiting 的 run 续跑抛 InvalidTransition", () => {
    stack = buildStack();
    const script = makeScript(MEME_DOC);
    const trialResult = stack.service.trial(script.id);
    expect(() => stack.service.resume(trialResult.run_id)).toThrow(InvalidTransition);
  });

  it("按版本运行用钉住版本的 doc（plan_created 的 steps 来自旧版本）", () => {
    stack = buildStack();
    const script = makeScript(MEME_DOC); // v1：3 步
    const edited: ScriptRecord = {
      ...script,
      doc: {
        name: "新闻驱动 meme 买入",
        params: [{ key: "asset", label: "资产", type: "string", default: "USDC" }],
        steps: [{ tool: "aave.rates", args: { asset: "${asset}" }, save_as: "rates" }],
        requires_approval_before_step: 1,
        final_step: { tool: "aave.sim_supply", args: { asset: "${asset}", amount_usd: 10 } },
      },
    };
    stack.scripts.updateScript(edited); // → v2（2 步）
    const result = stack.service.run(script.id, { version: 1, trial: true });
    expect(result.status).toBe("done");
    expect(result.steps).toHaveLength(3); // 跑的是 v1 的 doc
    const plan = stack.runs
      .listEvents(result.run_id, 0)
      .find((e) => e.type === "plan_created");
    expect(plan?.payload.steps).toBe(3);
    // 与 Python 一致的口径：plan_created.version 记运行当时的 current_version（=2）
    expect(plan?.payload.version).toBe(2);
  });
});
