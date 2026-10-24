// api 层测试：角色归一化、错误文案、fetch 行为。
// 响应样本取两后端真实形状：Python api.py 与 server serializers.ts
// 的消息/错误体（system 角色、{"error":...} 错误体）。
import { describe, expect, it, vi} from "vitest";
import { ApiError, api, apiErrorText, normalizeMessageRole, setUnauthorizedHandler} from "./api";

describe("normalizeMessageRole", () => {
it("旧前端的 sys 映射为 system（两后端落库均为 system）", () => {
expect(normalizeMessageRole("sys")).toBe("system");
});
it("system / user / assistant 原样通过", () => {
expect(normalizeMessageRole("system")).toBe("system");
expect(normalizeMessageRole("user")).toBe("user");
expect(normalizeMessageRole("assistant")).toBe("assistant");
});
});

describe("apiErrorText", () => {
it("服务端 JSON 错误体只取 error 字段，不把整段 JSON 贴给用户", () => {
expect(apiErrorText(new ApiError(400, '{"error": "金额超限"}'))).toBe("请求失败：金额超限");
});
it("401 译为登录过期", () => {
expect(apiErrorText(new ApiError(401, "unauthorized"))).toBe("登录已过期，请重新进入");
});
it("网络 TypeError 译为连接失败", () => {
expect(apiErrorText(new TypeError("fetch failed"))).toBe("网络连接失败，请检查后重试");
});
});

describe("api()", () => {
it("401 时触发未登录回调并抛 ApiError(401)", async () => {
const onAuth = vi.fn();
setUnauthorizedHandler(onAuth);
vi.stubGlobal(
"fetch",
vi.fn().mockResolvedValue({ status: 401, ok: false, text: async () => ""}),
);
await expect(api("/api/chats")).rejects.toMatchObject({ status: 401});
expect(onAuth).toHaveBeenCalledOnce();
vi.unstubAllGlobals();
});

it("204 返回 null 而不是尝试解析 JSON", async () => {
vi.stubGlobal(
"fetch",
vi.fn().mockResolvedValue({ status: 204, ok: true, json: async () => null}),
);
await expect(api("/api/memories/x")).resolves.toBeNull();
vi.unstubAllGlobals();
});

it("成功时返回解析后的 JSON（Python/server 两后端同形）", async () => {
const body = [{ id: "m1", chat_id: "c1", role: "system", content: "BONK"}];
vi.stubGlobal(
"fetch",
vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => body}),
);
await expect(api("/api/chats/c1/messages")).resolves.toEqual(body);
vi.unstubAllGlobals();
});
});
