// SSE 序号纯逻辑（四维评审 FE-2）：与 Vue 解耦，可单测。
// server 的 SSE 帧形如 `id: <seq>` + `data: {seq, type, ...}`，
// 订阅 URL 带 after=已收最大 seq 时服务端只发更新的事件。

/** 从事件体或 EventSource 的 lastEventId 里取序号；取不到返回 null。 */
export function eventSeqOf(
  event: { seq?: unknown },
  lastEventId?: string,
): number | null {
  if (typeof event.seq === "number" && Number.isFinite(event.seq)) return event.seq;
  if (typeof event.seq === "string" && /^\d+$/.test(event.seq)) return Number(event.seq);
  if (lastEventId && /^\d+$/.test(lastEventId)) return Number(lastEventId);
  return null;
}

export function eventsUrl(runId: string, after: number): string {
  return `/api/events?run_id=${encodeURIComponent(runId)}&after=${after}`;
}

/** 按运行 id 记住的已收最大序号：断线重连/组件重挂后从该点续传。 */
export class SeqTracker {
  private maxByRun = new Map<string, number>();

  maxSeq(runId: string): number {
    return this.maxByRun.get(runId) ?? 0;
  }

  reset(runId: string): void {
    this.maxByRun.set(runId, 0);
  }

  forget(runId: string): void {
    this.maxByRun.delete(runId);
  }

  /**
   * 判定一条事件是否应投递：无序号的事件无法去重、一律投递；
   * 有序号且 <= 已收最大值的为重放帧，丢弃。
   */
  accept(runId: string, seq: number | null): boolean {
    if (seq === null) return true;
    const max = this.maxSeq(runId);
    if (seq <= max) return false;
    this.maxByRun.set(runId, seq);
    return true;
  }
}
