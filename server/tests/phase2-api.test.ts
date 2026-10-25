import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../src/app.js";
import { makeConfig } from "../src/config.js";
import { FEED_PROMPT_V1 } from "../src/application/seed.js";

let built: BuiltApp | undefined;

afterEach(async () => {
  await built?.close();
  built = undefined;
});

async function loginCookie(app: BuiltApp["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "test-pw" },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookie).split(";", 1)[0]!;
}

function newApp(): BuiltApp {
  built = buildApp(
    makeConfig({ dbPath: ":memory:", password: "test-pw", startScheduler: false }),
  );
  return built;
}

interface FeedItemJson {
  id: string;
  title: string;
  entities: Array<{ label: string; value: string; kind: string }>;
}

describe("二期 API：精选与提示词", () => {
  it("种子后精选有条目，id 为 sha1(source+title) 前 32 位且刷新两次不变", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const first = (await app.inject({ method: "GET", url: "/api/feed", headers })).json() as FeedItemJson[];
    expect(first.length).toBeGreaterThan(0);
    const bonk = first.find((i) => i.title.includes("BONK"));
    expect(bonk).toBeDefined();
    const expected = createHash("sha1")
      .update(`SeedNews\n${bonk!.title}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    expect(bonk!.id).toBe(expected);

    await app.inject({ method: "POST", url: "/api/feed/refresh", headers });
    const second = (await app.inject({ method: "GET", url: "/api/feed", headers })).json() as FeedItemJson[];
    expect(second.map((i) => i.id).sort()).toEqual(first.map((i) => i.id).sort());
  });

  it("零命中时回退全池并带 fallback 标记，不冒充命中", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const put = await app.inject({
      method: "PUT", url: "/api/prompts/feed", headers,
      payload: { content: "只看量子计算进展" },
    });
    expect(put.statusCode).toBe(200);
    const items = (await app.inject({ method: "GET", url: "/api/feed", headers })).json() as FeedItemJson[];
    expect(items.length).toBe(6);
    for (const item of items) {
      expect(item.entities.some((e) => e.kind === "fallback")).toBe(true);
    }
  });

  it("prompts 版本化：PUT 递增版本、versions 列表、rollback 存为新版本、回滚不存在版本 404", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const initial = (await app.inject({ method: "GET", url: "/api/prompts/feed", headers })).json() as { content: string; version: number };
    expect(initial.version).toBe(1);
    expect(initial.content).toBe(FEED_PROMPT_V1);

    const put = (await app.inject({
      method: "PUT", url: "/api/prompts/feed", headers,
      payload: { content: "只看 Aave 利率" },
    })).json() as { content: string; version: number };
    expect(put.version).toBe(2);

    const versions = (await app.inject({ method: "GET", url: "/api/prompts/feed/versions", headers })).json() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    const rolled = (await app.inject({
      method: "POST", url: "/api/prompts/feed/rollback", headers,
      payload: { version: 1 },
    })).json() as { content: string; version: number };
    expect(rolled.content).toBe(FEED_PROMPT_V1);
    expect(rolled.version).toBe(3);

    const missing = await app.inject({
      method: "POST", url: "/api/prompts/feed/rollback", headers,
      payload: { version: 99 },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("二期 API：脚本与定时任务", () => {
  it("脚本列表/详情/build/trial/run 全链：trial 出步骤、run 停审批", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const list = (await app.inject({ method: "GET", url: "/api/scripts", headers })).json() as Array<{ id: string; name: string; version: number; params: unknown[] }>;
    expect(list.map((s) => s.name).sort()).toEqual(["Aave 收益脚本", "新闻驱动 meme 买入"]);

    const meme = list.find((s) => s.name === "新闻驱动 meme 买入")!;
    const detail = await app.inject({ method: "GET", url: `/api/scripts/${meme.id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { version: number }).version).toBe(1);

    const draft = (await app.inject({
      method: "POST", url: "/api/scripts/build", headers,
      payload: { intent: "买 BONK，200 美元" },
    })).json() as { name: string; params: Array<{ key: string; default?: unknown }> };
    expect(draft.name).toBe("新闻驱动 meme 买入");
    const tokenParam = draft.params.find((p) => p.key === "token");
    const amountParam = draft.params.find((p) => p.key === "amount_usd");
    expect(tokenParam?.default).toBe("BONK");
    expect(amountParam?.default).toBe(200);

    const trial = (await app.inject({
      method: "POST", url: `/api/scripts/${meme.id}/trial`, headers, payload: {},
    })).json() as { status: string; steps: unknown[] };
    expect(trial.status).toBe("done");
    expect(trial.steps).toHaveLength(3);

    const run = (await app.inject({
      method: "POST", url: `/api/scripts/${meme.id}/run`, headers, payload: {},
    })).json() as { status: string; approval_id?: string };
    expect(run.status).toBe("awaiting_approval");
    expect(run.approval_id).toBeTruthy();
  });

  it("jobs：非法 trigger 创建 400 且不落库；合法创建 next_run_at 在未来；toggle 翻转", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const scripts = (await app.inject({ method: "GET", url: "/api/scripts", headers })).json() as Array<{ id: string }>;
    const scriptId = scripts[0]!.id;
    const before = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as unknown[];
    expect(before).toHaveLength(1); // 种子任务

    const bad = await app.inject({
      method: "POST", url: "/api/jobs", headers,
      payload: { script_id: scriptId, trigger: { type: "time", every_minutes: 0 } },
    });
    expect(bad.statusCode).toBe(400);
    const afterBad = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as unknown[];
    expect(afterBad).toHaveLength(1);

    const created = (await app.inject({
      method: "POST", url: "/api/jobs", headers,
      payload: {
        name: "五分钟看一次",
        script_id: scriptId,
        trigger: { type: "time", every_minutes: 5 },
      },
    })).json() as { id: string; enabled: boolean; next_run_at: string; last_status: string };
    expect(created.enabled).toBe(true);
    expect(new Date(created.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(created.last_status).toBe("");

    const toggled = (await app.inject({
      method: "POST", url: `/api/jobs/${created.id}/toggle`, headers,
    })).json() as { enabled: boolean };
    expect(toggled.enabled).toBe(false);
  });
});

describe("二期 API：记忆分级与裁决", () => {
  it("fact→active、未给级别→pending、never→403；decide 只许 pending、approved 须布尔；DELETE 204", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const list = async () =>
      (await app.inject({ method: "GET", url: "/api/memories", headers })).json() as Array<{
        id: string; content: string; level: string; status: string;
      }>;
    const seedList = await list();
    expect(seedList).toHaveLength(2);
    expect(seedList.find((m) => m.level === "fact")?.status).toBe("active");
    const pending = seedList.find((m) => m.status === "pending")!;
    expect(pending.level).toBe("inference");

    const fact = (await app.inject({
      method: "POST", url: "/api/memories", headers,
      payload: { content: "用户住在北京。", level: "fact" },
    })).json() as { status: string };
    expect(fact.status).toBe("active");

    const inferred = (await app.inject({
      method: "POST", url: "/api/memories", headers,
      payload: { content: "用户可能喜欢夜跑。" },
    })).json() as { status: string; level: string };
    expect(inferred.status).toBe("pending");
    expect(inferred.level).toBe("inference");

    const never = await app.inject({
      method: "POST", url: "/api/memories", headers,
      payload: { content: "这条别记。", level: "never" },
    });
    expect(never.statusCode).toBe(403);

    // 对 active 的记忆 decide → 409
    const activeId = (await list()).find((m) => m.status === "active")!.id;
    const conflict = await app.inject({
      method: "POST", url: `/api/memories/${activeId}/decide`, headers,
      payload: { approved: true },
    });
    expect(conflict.statusCode).toBe(409);

    // approved 传字符串 → 400 且状态未动
    const badFlag = await app.inject({
      method: "POST", url: `/api/memories/${pending.id}/decide`, headers,
      payload: { approved: "true" },
    });
    expect(badFlag.statusCode).toBe(400);
    expect((await list()).find((m) => m.id === pending.id)?.status).toBe("pending");

    // 真布尔批准 → active
    const decided = (await app.inject({
      method: "POST", url: `/api/memories/${pending.id}/decide`, headers,
      payload: { approved: true },
    })).json() as { status: string };
    expect(decided.status).toBe("active");

    // DELETE → 204，删不存在 → 404
    const del = await app.inject({ method: "DELETE", url: `/api/memories/${pending.id}`, headers });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
    const delAgain = await app.inject({ method: "DELETE", url: `/api/memories/${pending.id}`, headers });
    expect(delAgain.statusCode).toBe(404);
  });
});

describe("二期 API：文件下载与连接状态", () => {
  it("种子文件可下载（script: ref 现拼 doc JSON），未知文件/不支持 ref 404", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const files = (await app.inject({ method: "GET", url: "/api/files", headers })).json() as Array<{ id: string; name: string; kind: string }>;
    expect(files).toHaveLength(2);
    const target = files.find((f) => f.name.includes("Aave"))!;
    const res = await app.inject({ method: "GET", url: `/api/files/${target.id}/download`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''");
    const doc = JSON.parse(res.body) as { name: string };
    expect(doc.name).toBe("Aave 收益脚本");

    const missing = await app.inject({ method: "GET", url: "/api/files/nope/download", headers });
    expect(missing.statusCode).toBe(404);
  });

  it("connections 五行齐全，AgentCore 未配置诚实 not_configured，OKX 未配置诚实未配置，响应不含密钥样值", async () => {
    const { app } = newApp();
    const headers = { cookie: await loginCookie(app) };
    const rows = (await app.inject({ method: "GET", url: "/api/settings/connections", headers })).json() as Array<{ name: string; status: string; detail: string }>;
    expect(rows.map((r) => r.name)).toEqual(["模型通道", "OKX 交易所", "Agent 运行时", "AWS AgentCore", "密钥库"]);
    expect(rows[3]?.status).toBe("not_configured");
    expect(rows[0]?.status).toContain("Mock");
    expect(rows[1]?.status).toBe("未配置");
    expect(rows[4]?.status).toBe("暂无登记引用");
  });
});

describe("前端同源托管（@fastify/static）", () => {
  it("GET / 返回 Vue index.html，/assets/* 200，/api/* 仍走 API（401 而非静态）", async () => {
    const { app } = newApp();
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain('<div id="app">');

    const assetsDir = path.resolve(process.cwd(), "..", "web", "assets");
    const asset = readdirSync(assetsDir).find((f) => f.endsWith(".js"))!;
    const assetRes = await app.inject({ method: "GET", url: `/assets/${asset}` });
    expect(assetRes.statusCode).toBe(200);

    const apiRes = await app.inject({ method: "GET", url: "/api/feed" });
    expect(apiRes.statusCode).toBe(401); // 未登录走 API 鉴权，不是静态文件
  });
});
