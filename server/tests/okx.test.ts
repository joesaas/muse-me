import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GuardrailDenied, NotFound } from "../src/domain/errors.js";
import { PLUGIN_TEMPLATES } from "../src/domain/plugin-catalog.js";
import { TOOL_DEFS } from "../src/domain/tool-catalog.js";
import { DEFAULT_GUARDRAIL_POLICY, type ScriptDoc } from "../src/domain/types.js";

const finalTool = (d: ScriptDoc): unknown =>
  (d.final_step as Record<string, unknown> | undefined)?.tool;
import { ScriptEngine } from "../src/application/script-engine.js";
import { OkxClient, type FetchImpl } from "../src/infrastructure/okx/okx-client.js";
import { floorToLot, OkxToolRegistry } from "../src/infrastructure/okx/okx-tools.js";
import { CompositeToolRegistry } from "../src/infrastructure/tools/composite-tools.js";
import { SimulatedToolRegistry } from "../src/infrastructure/tools/simulated-tools.js";
import { DEFAULT_NEWS_POOL } from "../src/infrastructure/tools/seed-news.js";
import { openDatabase } from "../src/infrastructure/sqlite/database.js";
import { SqliteApprovalStore } from "../src/infrastructure/sqlite/approvals.store.js";
import { SqliteFeedStore } from "../src/infrastructure/sqlite/feed.store.js";
import { SqliteRunStore } from "../src/infrastructure/sqlite/runs.store.js";
import { SqliteScriptStore } from "../src/infrastructure/sqlite/scripts.store.js";

const DEMO_CFG = {
  apiKey: "demo-key",
  apiSecret: "demo-secret",
  passphrase: "demo-pass",
  demo: true,
  allowLive: false,
  baseUrl: "https://www.okx.com",
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** 按 URL 子串匹配的桩 fetch：返回 {code, msg, data} 的 OKX 信封。 */
function makeStub(
  routes: Array<{ match: string; data: unknown }>,
  seen: Seen[],
  code = "0",
): FetchImpl {
  return async (url, init) => {
    seen.push({ method: init.method, url, headers: init.headers, body: init.body });
    const route = routes.find((r) => url.includes(r.match));
    const payload = route
      ? { code, msg: "", data: route.data }
      : { code: "50001", msg: "stub 未命中", data: [] };
    return { ok: true, status: 200, json: async () => payload };
  };
}

describe("OKX 配置", () => {
  it("默认模拟盘、不放行实盘", () => {
    const cfg = loadConfig({});
    expect(cfg.okx.demo).toBe(true);
    expect(cfg.okx.allowLive).toBe(false);
    expect(cfg.okx.apiKey).toBe("");
  });

  it("非法开关直接抛错，不静默降级", () => {
    expect(() => loadConfig({ OKX_DEMO: "yes" })).toThrow(/OKX_DEMO 非法/);
    expect(() => loadConfig({ OKX_ALLOW_LIVE: "maybe" })).toThrow(/OKX_ALLOW_LIVE 非法/);
  });
});

describe("OKX 签名与 header", () => {
  it("固定时间戳下签名可复算；模拟盘带 x-simulated-trading", () => {
    const fixed = new Date("2020-12-08T09:08:57.715Z");
    const client = new OkxClient(DEMO_CFG, undefined, () => fixed);
    const ts = "2020-12-08T09:08:57.715Z";
    const headers = client.signHeaders("GET", "/api/v5/account/balance", "", ts);
    const expected = createHmac("sha256", "demo-secret")
      .update(`${ts}GET/api/v5/account/balance`, "utf8")
      .digest("base64");
    expect(headers["OK-ACCESS-SIGN"]).toBe(expected);
    expect(headers["OK-ACCESS-KEY"]).toBe("demo-key");
    expect(headers["x-simulated-trading"]).toBe("1");
    const live = new OkxClient({ ...DEMO_CFG, demo: false, allowLive: true });
    expect(live.signHeaders("GET", "/api/v5/account/balance", "", ts)["x-simulated-trading"])
      .toBeUndefined();
  });
});

describe("OKX 客户端", () => {
  it("未配置时余额直接拒绝，不发请求", async () => {
    const seen: Seen[] = [];
    const client = new OkxClient({ ...DEMO_CFG, apiKey: "" }, makeStub([], seen));
    await expect(client.balance()).rejects.toBeInstanceOf(GuardrailDenied);
    expect(seen).toHaveLength(0);
  });

  it("余额解析与 OKX 错误码映射", async () => {
    const seen: Seen[] = [];
    const client = new OkxClient(
      DEMO_CFG,
      makeStub(
        [{ match: "/api/v5/account/balance", data: [{ details: [{ ccy: "USDT", bal: "10000", availBal: "9990", frozenBal: "10" }] }] }],
        seen,
      ),
    );
    const rows = await client.balance();
    expect(rows[0]).toEqual({ ccy: "USDT", bal: "10000", availBal: "9990", frozenBal: "10" });
    expect(seen[0]!.headers["x-simulated-trading"]).toBe("1");

    const failing = new OkxClient(
      DEMO_CFG,
      async () => ({ ok: true, status: 200, json: async () => ({ code: "50101", msg: "API key 不存在", data: [] }) }),
    );
    await expect(failing.balance()).rejects.toThrow(/50101.*API key 不存在/);
  });

  it("交易门：模拟盘放行，实盘未放行拒绝", () => {
    expect(() => new OkxClient(DEMO_CFG).assertTradable()).not.toThrow();
    const live = new OkxClient({ ...DEMO_CFG, demo: false, allowLive: false });
    expect(() => live.assertTradable()).toThrow(/真实交易未开启/);
    const liveOk = new OkxClient({ ...DEMO_CFG, demo: false, allowLive: true });
    expect(() => liveOk.assertTradable()).not.toThrow();
  });
});

describe("OKX 工具", () => {
  function registryWith(stub: FetchImpl, cfg = DEMO_CFG) {
    return new OkxToolRegistry(new OkxClient(cfg, stub));
  }

  it("试运行现货买入只出预览，不发下单请求", async () => {
    const seen: Seen[] = [];
    const tools = registryWith(makeStub([], seen));
    const out = await tools.call(
      "okx.spot_order",
      { inst_id: "BTC-USDT", side: "buy", amount_usd: 100 },
      "simulate",
    );
    expect(out.status).toBe("preview");
    expect(out.tgt_ccy).toBe("quote_ccy");
    expect(seen).toHaveLength(0);
  });

  it("正式运行现货买入发市价单（quote_ccy、模拟盘 header）", async () => {
    const seen: Seen[] = [];
    const tools = registryWith(
      makeStub(
        [{ match: "/api/v5/trade/order", data: [{ ordId: "123", clOrdId: "", sCode: "0", sMsg: "" }] }],
        seen,
      ),
    );
    const out = await tools.call(
      "okx.spot_order",
      { inst_id: "BTC-USDT", side: "buy", amount_usd: 100 },
      "execute",
    );
    expect(out.status).toBe("placed");
    expect(out.ord_id).toBe("123");
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    const body = JSON.parse(req.body!);
    expect(body).toMatchObject({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", tgtCcy: "quote_ccy" });
    expect(req.headers["x-simulated-trading"]).toBe("1");
  });

  it("永续张数按现价与面值折算、向下取 lotSz 整数倍", () => {
    expect(floorToLot(0.206, "0.01")).toBe(0.2);
    expect(floorToLot(0.001, "0.01")).toBe(0);
    expect(floorToLot(3, "1")).toBe(3);
  });

  it("永续做多预览与正式下单（posSide long、cross）", async () => {
    const seen: Seen[] = [];
    const stub = makeStub(
      [
        { match: "/api/v5/market/ticker", data: [{ instId: "BTC-USDT-SWAP", last: "50000" }] },
        { match: "/api/v5/public/instruments", data: [{ instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.01", minSz: "0.01", tickSz: "0.1" }] },
        { match: "/api/v5/trade/order", data: [{ ordId: "456", clOrdId: "", sCode: "0", sMsg: "" }] },
      ],
      seen,
    );
    const tools = registryWith(stub);
    const preview = await tools.call(
      "okx.perp_order",
      { inst_id: "BTC-USDT-SWAP", side: "long", amount_usd: 100 },
      "simulate",
    );
    // 100 / (50000 * 0.01) = 0.2 张
    expect(preview.contracts).toBe(0.2);
    expect(preview.status).toBe("preview");
    const placed = await tools.call(
      "okx.perp_order",
      { inst_id: "BTC-USDT-SWAP", side: "long", amount_usd: 100 },
      "execute",
    );
    expect(placed.ord_id).toBe("456");
    const orderReq = seen.find((s) => s.method === "POST")!;
    const body = JSON.parse(orderReq.body!);
    expect(body).toMatchObject({ instId: "BTC-USDT-SWAP", tdMode: "cross", side: "buy", posSide: "long", ordType: "market", sz: "0.2" });
  });

  it("永续金额过小与非 SWAP 标的直接拒绝", async () => {
    const stub = makeStub(
      [
        { match: "/api/v5/market/ticker", data: [{ instId: "BTC-USDT-SWAP", last: "50000" }] },
        { match: "/api/v5/public/instruments", data: [{ instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.01", minSz: "0.01", tickSz: "0.1" }] },
      ],
      [],
    );
    const tools = registryWith(stub);
    await expect(
      tools.call("okx.perp_order", { inst_id: "BTC-USDT-SWAP", side: "long", amount_usd: 1 }, "execute"),
    ).rejects.toBeInstanceOf(GuardrailDenied);
    await expect(
      tools.call("okx.perp_order", { inst_id: "BTC-USDT", side: "long", amount_usd: 100 }, "execute"),
    ).rejects.toThrow(/须为永续合约/);
  });

  it("mode=live 一律拒绝（环境由配置定）", async () => {
    const tools = registryWith(makeStub([], []));
    await expect(
      tools.call("okx.spot_order", { inst_id: "BTC-USDT", side: "buy", amount_usd: 100 }, "live"),
    ).rejects.toThrow(/不接受 mode=live/);
  });
});

describe("组合注册表", () => {
  it("okx.* 走真实分支，其余走模拟，未知抛 NotFound", async () => {
    const seen: Seen[] = [];
    const okx = new OkxToolRegistry(
      new OkxClient(
        DEMO_CFG,
        makeStub([{ match: "/api/v5/market/ticker", data: [{ instId: "BTC-USDT", last: "97000" }] }], seen),
      ),
    );
    const composite = new CompositeToolRegistry(
      new SimulatedToolRegistry(DEFAULT_NEWS_POOL),
      okx,
    );
    expect(composite.hasTool("okx.ticker")).toBe(true);
    expect(composite.hasTool("market.quote")).toBe(true);
    expect(composite.hasTool("okx.nope")).toBe(false);
    const tick = await composite.call("okx.ticker", { inst_id: "BTC-USDT" });
    expect(tick.price_usd).toBe(97000);
    const quote = await composite.call("market.quote", { symbol: "BTC" });
    expect(quote.source).toBe("simulated");
    await expect(composite.call("okx.nope", {})).rejects.toBeInstanceOf(NotFound);
  });
});

describe("插件目录", () => {
  it("模板 id 与名唯一，步骤工具都在白名单、插值只引已知参数", () => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const t of PLUGIN_TEMPLATES) {
      expect(ids.has(t.id)).toBe(false);
      expect(names.has(t.name)).toBe(false);
      ids.add(t.id);
      names.add(t.name);
      const params = (t.doc.params ?? []) as Array<Record<string, unknown>>;
      const paramKeys = new Set(params.map((p) => String(p.key)));
      const rawSteps = (t.doc.steps ?? []) as Array<Record<string, unknown>>;
      const steps = [...rawSteps, ...(t.doc.final_step ? [t.doc.final_step as Record<string, unknown>] : [])];
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(TOOL_DEFS.has(String(step.tool))).toBe(true);
        const argsText = JSON.stringify(step.args ?? {});
        for (const m of argsText.matchAll(/\$\{([^{}]+)\}/g)) {
          const head = m[1]!.split(".", 1)[0]!;
          expect(paramKeys.has(head) || head === "entity").toBe(true);
        }
      }
    }
  });
});

describe("引擎 OKX 草稿分支", () => {
  function buildEngine() {
    const db = openDatabase(":memory:");
    const runs = new SqliteRunStore(db);
    const approvals = new SqliteApprovalStore(db);
    const scripts = new SqliteScriptStore(db);
    const feed = new SqliteFeedStore(db);
    const tools = new SimulatedToolRegistry(DEFAULT_NEWS_POOL);
    const engine = new ScriptEngine(runs, approvals, scripts, feed, tools, DEFAULT_GUARDRAIL_POLICY, "demo-user");
    return { db, engine };
  }

  it("显式 OKX 信号走真实分支；只说买 BTC 仍走模拟骨架", () => {
    const { db, engine } = buildEngine();
    try {
      const spot = engine.buildDraft("用 OKX 买 BTC 100 美元", null);
      expect(spot.name).toBe("OKX 现货买入");
      expect(finalTool(spot)).toBe("okx.spot_order");
      engine.validateScript(spot);
      const perp = engine.buildDraft("做多 BTC 200 美元", null);
      expect(perp.name).toBe("OKX 永续做多");
      expect(finalTool(perp)).toBe("okx.perp_order");
      engine.validateScript(perp);
      const short = engine.buildDraft("做空 ETH", null);
      expect(short.name).toBe("OKX 永续做空");
      const meme = engine.buildDraft("买 BTC", null);
      expect(finalTool(meme)).toBe("dex.sim_swap");
    } finally {
      db.close();
    }
  });
});
