// SSE 续传与去重测试（四维评审 FE-2）：
// 样本取 server sse.ts 的真实帧形（id: seq + data 含 seq）。
import { describe, expect, it } from "vitest";
import { SeqTracker, eventSeqOf, eventsUrl } from "./streamSeq";

describe("eventSeqOf", () => {
  it("优先取 data 里的 seq", () => {
    expect(eventSeqOf({ seq: 7 }, "5")).toBe(7);
  });
  it("data 无 seq 时取帧 id（lastEventId）", () => {
    expect(eventSeqOf({}, "12")).toBe(12);
  });
  it("两处都没有时返回 null（无法去重，一律投递）", () => {
    expect(eventSeqOf({})).toBeNull();
  });
});

describe("eventsUrl", () => {
  it("订阅带 after=已收最大 seq", () => {
    expect(eventsUrl("run-1", 9)).toBe("/api/events?run_id=run-1&after=9");
  });
});

describe("SeqTracker", () => {
  it("重连重放帧被丢弃，新帧投递且 max 前进", () => {
    const t = new SeqTracker();
    expect(t.accept("r1", 1)).toBe(true);
    expect(t.accept("r1", 2)).toBe(true);
    expect(t.accept("r1", 2)).toBe(false); // 重放
    expect(t.accept("r1", 1)).toBe(false); // 旧帧
    expect(t.accept("r1", 3)).toBe(true);
    expect(t.maxSeq("r1")).toBe(3);
  });
  it("无序号事件无法去重，一律投递且不影响 max", () => {
    const t = new SeqTracker();
    expect(t.accept("r1", 5)).toBe(true);
    expect(t.accept("r1", null)).toBe(true);
    expect(t.maxSeq("r1")).toBe(5);
  });
  it("各 run 的序号互不干扰；reset 只清指定 run", () => {
    const t = new SeqTracker();
    t.accept("r1", 4);
    t.accept("r2", 9);
    t.reset("r1");
    expect(t.maxSeq("r1")).toBe(0);
    expect(t.maxSeq("r2")).toBe(9);
  });
});
