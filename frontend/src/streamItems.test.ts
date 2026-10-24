// 流式合并测试（四维评审 FE-3）：模拟「流式中切回窗口」——
// 落库重拉后，本地增量（工具行、系统行、流式气泡）必须还在，
// 而不是被整表覆盖；终态后 live 清空，重拉即为纯落库视图。
import { describe, expect, it} from "vitest";
import { isTerminalEventType, mergeDisplayItems} from "./streamItems";
import type { Message} from "./types";

const db: Message[] = [
{ id: "m1", chat_id: "c1", role: "user", content: "买这个 meme"},
{ id: "m2", chat_id: "c1", role: "system", content: "BONK"},
];

describe("mergeDisplayItems", () => {
it("无 live 时就是落库消息原样（sys 旧值归一为 system）", () => {
const out = mergeDisplayItems(
[{ id: "m0", chat_id: "c1", role: "sys" as never, content: "旧系统消息"}],
null,
);
expect(out).toEqual([{ kind: "msg", role: "system", content: "旧系统消息"}]);
});

it("重拉后本地增量与流式气泡不丢失，顺序为落库→增量→气泡", () => {
const out = mergeDisplayItems(db, {
extras: [
{ kind: "tool", text: "用了工具：查流动性与风险"},
{ kind: "msg", role: "system", content: "有一件事停在「待我确认」里等你拍板"},
],
bubble: { kind: "msg", role: "assistant", content: "已查到 BONK 流动性…"},
});
expect(out.map((it) => (it.kind === "msg"? it.content: it.text))).toEqual([
"买这个 meme",
"BONK",
"用了工具：查流动性与风险",
"有一件事停在「待我确认」里等你拍板",
"已查到 BONK 流动性…",
]);
});

it("live 为空气泡时仍追加（发送瞬间已有占位气泡）", () => {
const out = mergeDisplayItems(db, { extras: [], bubble: { kind: "msg", role: "assistant", content: ""}});
expect(out).toHaveLength(3);
});
});

describe("isTerminalEventType", () => {
it("三终态为真，其余为假", () => {
expect(isTerminalEventType("run_done")).toBe(true);
expect(isTerminalEventType("run_failed")).toBe(true);
expect(isTerminalEventType("run_cancelled")).toBe(true);
expect(isTerminalEventType("approval_required")).toBe(false);
expect(isTerminalEventType("assistant_delta")).toBe(false);
});
});
