// 运行事件流订阅：EventSource + 断线指数退避重连。
// 后端 SSE 在终态或 awaiting_approval 时会主动关流，
// 因此：终态事件到达即停；流在未见终态时断开则退避重连；
// awaiting_approval 不自动重连，续跑由用户批准后通过「按 runId 重新订阅」恢复。
// 续传（四维评审 FE-2）：每条事件按 seq 去重（重放帧丢弃），
// 重连订阅 URL 带 after=已收最大 seq，服务端只发更新的事件，
// 不再从头全量重放。序号状态按 runId 保存在模块级 SeqTracker 里，
// 组件重挂后 resume 也能从断点继续。
import { onUnmounted, ref } from "vue";
import type { RunEvent } from "../types";
import { useAppStore } from "../stores/app";
import { SeqTracker, eventSeqOf, eventsUrl } from "../streamSeq";
import { isTerminalEventType } from "../streamItems";

export type StreamEvent = RunEvent & { type: string };

const MAX_BACKOFF_MS = 15_000;
const tracker = new SeqTracker();

export function useRunStream(onEvent: (e: StreamEvent) => void) {
  const connected = ref(false);
  const awaiting = ref(false);
  let es: EventSource | null = null;
  let runId: string | null = null;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let sawTerminal = false;

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function closeSource(): void {
    es?.close();
    es = null;
    connected.value = false;
  }

  function open(): void {
    if (stopped || !runId) return;
    closeSource();
    const after = tracker.maxSeq(runId);
    es = new EventSource(eventsUrl(runId, after));
    es.onopen = () => {
      connected.value = true;
      attempts = 0;
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      let e: StreamEvent;
      try {
        e = JSON.parse(ev.data) as StreamEvent;
      } catch {
        return;
      }
      // 序号去重：重连后服务端若重发已收帧，在此丢弃，delta 不重复拼接。
      const seq = eventSeqOf(e, ev.lastEventId);
      if (!tracker.accept(runId as string, seq)) return;
      if (e.type === "approval_required") {
        awaiting.value = true;
        void useAppStore().refreshBadge();
      }
      onEvent(e);
      if (isTerminalEventType(e.type)) {
        sawTerminal = true;
        stop();
      }
    };
    es.onerror = () => {
      connected.value = false;
      closeSource();
      if (stopped || sawTerminal) return;
      if (awaiting.value) return; // 等待审批时后端已关流，靠重新订阅恢复，不空转重连
      const delay = Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
      attempts += 1;
      clearRetry();
      retryTimer = setTimeout(open, delay);
    };
  }

  /** 全新订阅一轮运行：序号从 0 开始。 */
  function subscribe(id: string): void {
    runId = id;
    tracker.reset(id);
    awaiting.value = false;
    sawTerminal = false;
    attempts = 0;
    stopped = false;
    clearRetry();
    open();
  }

  /** 从断点恢复订阅：序号沿用该 run 已收的最大值，不从头重放。 */
  function resume(id: string): void {
    runId = id;
    awaiting.value = false;
    sawTerminal = false;
    attempts = 0;
    stopped = false;
    clearRetry();
    open();
  }

  function stop(): void {
    stopped = true;
    clearRetry();
    closeSource();
  }

  onUnmounted(stop);

  return { connected, awaiting, subscribe, resume, stop };
}
