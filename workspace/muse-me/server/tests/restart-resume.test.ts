import { mkdtempSync, rmSync} from "node:fs";
import { tmpdir} from "node:os";
import path from "node:path";
import { describe, expect, it} from "vitest";
import { buildApp, type BuiltApp} from "../src/app.js";
import { makeConfig} from "../src/config.js";

/**
* 计划快照重启续跑实证（文件 DB）：
* 第一进程里让聊天 run 与脚本 run 都停在 awaiting；关进程后用同一 DB 文件
* 重建 app——聊天计划从 run_snapshots 快照重建、脚本从 run_events 重建，
* 两条 run 经审批决策都续跑到 done。
*/
describe("重启后续跑（快照落库）", () => {
it("server 重启后 awaiting 的聊天/脚本 run 仍可经审批续跑完成", async () => {
const dir = mkdtempSync(path.join(tmpdir(), "museme-phase2-"));
const dbPath = path.join(dir, "server.db");
const config = () =>
makeConfig({ dbPath, password: "test-pw", startScheduler: false});

let chatRunId = "";
let scriptRunId = "";
let built: BuiltApp | undefined;
try {
// ---------- 第一进程 ----------
built = buildApp(config());
const login1 = await built.app.inject({
method: "POST", url: "/api/login", payload: { password: "test-pw"},
});
const cookie1 = String(
(Array.isArray(login1.headers["set-cookie"])
? login1.headers["set-cookie"][0]
: login1.headers["set-cookie"])?? "",
).split(";", 1)[0]!;
const headers1 = { cookie: cookie1};

const feed = (await built.app.inject({
method: "GET", url: "/api/feed", headers: headers1,
})).json() as Array<{
id: string;
entities: Array<{ value: string; kind: string}>;
}>;
const bonk = feed.find((i) =>
i.entities.some((e) => e.kind === "token" && e.value === "BONK"),
)!;
expect(bonk).toBeDefined();

const chat = (await built.app.inject({
method: "POST", url: "/api/chats", headers: headers1,
payload: {
kind: "side", title: "构建脚本", feed_item_id: bonk.id, scene: "script_build",
},
})).json() as { id: string};

// 精选上下文已落为 system 消息
const messages = (await built.app.inject({
method: "GET", url: `/api/chats/${chat.id}/messages`, headers: headers1,
})).json() as Array<{ role: string; content: string}>;
expect(messages.some((m) => m.role === "sys" && m.content.includes(""))).toBe(true);

const sent = (await built.app.inject({
method: "POST", url: `/api/chats/${chat.id}/send`, headers: headers1,
payload: { text: "买这个 meme，100 美元"},
})).json() as { run_id: string};
chatRunId = sent.run_id;
const chatRun = (await built.app.inject({
method: "GET", url: `/api/runs/${chatRunId}`, headers: headers1,
})).json() as { status: string};
expect(chatRun.status).toBe("awaiting_approval");

// script_build 发送后脚本被 upsert 保存（种子 v1 → v2）
const scripts = (await built.app.inject({
method: "GET", url: "/api/scripts", headers: headers1,
})).json() as Array<{ id: string; name: string; version: number}>;
const meme = scripts.find((s) => s.name === "新闻驱动 meme 买入")!;
expect(meme.version).toBe(2);
const aave = scripts.find((s) => s.name === "Aave 收益脚本")!;

const scriptRun = (await built.app.inject({
method: "POST", url: `/api/scripts/${aave.id}/run`, headers: headers1, payload: {},
})).json() as { run_id: string; status: string};
scriptRunId = scriptRun.run_id;
expect(scriptRun.status).toBe("awaiting_approval");

const pendingBefore = (await built.app.inject({
method: "GET", url: "/api/approvals", headers: headers1,
})).json() as Array<{ id: string; amount_usd: number | null; status: string}>;
expect(pendingBefore.filter((a) => a.status === "pending")).toHaveLength(2);

await built.close();
built = undefined;

// ---------- 第二进程（同一 DB 文件） ----------
built = buildApp(config());
const login2 = await built.app.inject({
method: "POST", url: "/api/login", payload: { password: "test-pw"},
});
const cookie2 = String(
(Array.isArray(login2.headers["set-cookie"])
? login2.headers["set-cookie"][0]
: login2.headers["set-cookie"])?? "",
).split(";", 1)[0]!;
const headers2 = { cookie: cookie2};

const pendingAfter = (await built.app.inject({
method: "GET", url: "/api/approvals", headers: headers2,
})).json() as Array<{ id: string; amount_usd: number | null; status: string}>;
const pending = pendingAfter.filter((a) => a.status === "pending");
expect(pending).toHaveLength(2);
// 金额区分两条：聊天 sim_swap 100、脚本 sim_supply 1000
const chatApproval = pending.find((a) => a.amount_usd === 100)!;
const scriptApproval = pending.find((a) => a.amount_usd === 1000)!;
expect(chatApproval).toBeDefined();
expect(scriptApproval).toBeDefined();

const decideScript = await built.app.inject({
method: "POST", url: `/api/approvals/${scriptApproval.id}/decide`,
headers: headers2, payload: { approved: true},
});
expect(decideScript.statusCode).toBe(200);
const scriptRunAfter = (await built.app.inject({
method: "GET", url: `/api/runs/${scriptRunId}`, headers: headers2,
})).json() as { status: string; title: string};
expect(scriptRunAfter.status).toBe("done");
expect(scriptRunAfter.title).toBe("Aave 收益脚本");

const decideChat = await built.app.inject({
method: "POST", url: `/api/approvals/${chatApproval.id}/decide`,
headers: headers2, payload: { approved: true},
});
expect(decideChat.statusCode).toBe(200);
const chatRunAfter = (await built.app.inject({
method: "GET", url: `/api/runs/${chatRunId}`, headers: headers2,
})).json() as { status: string};
// 聊天计划只存在于快照（进程内存已随第一进程消亡）——done 即快照续跑实证
expect(chatRunAfter.status).toBe("done");

await built.close();
built = undefined;
} finally {
await built?.close();
rmSync(dir, { recursive: true, force: true});
}
});
});
