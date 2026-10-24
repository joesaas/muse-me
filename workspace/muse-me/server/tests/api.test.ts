import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../src/app.js";
import { makeConfig } from "../src/config.js";

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
  expect(cookie).toContain("muse_session=");
  expect(cookie).toContain("HttpOnly");
  return String(cookie).split(";", 1)[0]!;
}

describe("HTTP handler 级行为（app.inject）", () => {
  it("无 cookie 访问 /api/* 一律 401；错误口令登录 401", async () => {
    built = buildApp(makeConfig({ dbPath: ":memory:", password: "test-pw" }));
    const noAuth = await built.app.inject({ method: "GET", url: "/api/chats" });
    expect(noAuth.statusCode).toBe(401);
    const badLogin = await built.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "wrong" },
    });
    expect(badLogin.statusCode).toBe(401);
  });

  it('decide 布尔严校验：传字符串 "false" 得 400 且审批未动；真布尔 false 才生效', async () => {
    built = buildApp(makeConfig({ dbPath: ":memory:", password: "test-pw" }));
    const cookie = await loginCookie(built.app);
    const headers = { cookie };

    const chat = await built.app.inject({
      method: "POST",
      url: "/api/chats",
      headers,
      payload: { kind: "side", title: "新话题" },
    });
    const chatId = (chat.json() as { id: string }).id;
    const send = await built.app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/send`,
      headers,
      payload: { text: "买这个 meme，100 美元" },
    });
    expect(send.statusCode).toBe(200);
    const { run_id: runId } = send.json() as { run_id: string };

    const approvals = await built.app.inject({
      method: "GET",
      url: "/api/approvals",
      headers,
    });
    const list = approvals.json() as Array<{ id: string; status: string; amount_usd: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("pending");
    expect(list[0]?.amount_usd).toBe(100);

    const stringFalse = await built.app.inject({
      method: "POST",
      url: `/api/approvals/${list[0]!.id}/decide`,
      headers,
      payload: { approved: "false" },
    });
    expect(stringFalse.statusCode).toBe(400);

    const after = await built.app.inject({
      method: "GET",
      url: "/api/approvals",
      headers,
    });
    expect((after.json() as Array<{ status: string }>)[0]?.status).toBe("pending");

    const deny = await built.app.inject({
      method: "POST",
      url: `/api/approvals/${list[0]!.id}/decide`,
      headers,
      payload: { approved: false },
    });
    expect(deny.statusCode).toBe(200);
    expect((deny.json() as { status: string }).status).toBe("denied");

    const run = await built.app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
      headers,
    });
    expect((run.json() as { status: string }).status).toBe("failed");

    const repeat = await built.app.inject({
      method: "POST",
      url: `/api/approvals/${list[0]!.id}/decide`,
      headers,
      payload: { approved: true },
    });
    expect(repeat.statusCode).toBe(409);
  });

  it("GET /api/agent/health：local 模式下 agentcore 诚实报告 not_configured", async () => {
    built = buildApp(makeConfig({ dbPath: ":memory:", password: "test-pw" }));
    const cookie = await loginCookie(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: "/api/agent/health",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      runtimeMode: string;
      runtime: { status: string; runtime: string };
      agentcore: { status: string };
    };
    expect(body.runtimeMode).toBe("local");
    expect(body.runtime.status).toBe("ok");
    expect(body.runtime.runtime).toBe("local");
    expect(body.agentcore.status).toBe("not_configured");
  });

  it("GET /api/agent/runtimes 未配置时 503，不伪装空列表", async () => {
    built = buildApp(makeConfig({ dbPath: ":memory:", password: "test-pw" }));
    const cookie = await loginCookie(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: "/api/agent/runtimes",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(503);
  });
});
