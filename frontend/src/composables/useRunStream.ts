// 运行事件流订阅：EventSource + 断线指数退避重连。
// 后端 SSE 在终态或 awaiting_approval 时会主动关流（api.py _events），
// 因此：终态事件到达即停；流在未见终态时断开（网络抖动/120s 上限）则退避重连；
// awaiting_approval 也会关流——此时不自动重连，续跑由用户批准后通过
// 「按 runId 重新订阅」恢复（ChatView 在窗口聚焦/返回时调用 subscribe）。
import { onUnmounted, ref } from "vue";
import type { RunEvent } from "../types";
import { useAppStore } from "../stores/app";

export type StreamEvent = RunEvent & { type: string };

const TERMINAL = ["run_done", "run_failed", "run_cancelled"];
const MAX_BACKOFF_MS = 15_000;

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
    es = new EventSource(`/api/events?run_id=${runId}`);
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
      if (e.type === "approval_required") {
        awaiting.value = true;
        void useAppStore().refreshBadge();
      }
      onEvent(e);
      if (TERMINAL.includes(e.type)) {
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

  function subscribe(id: string): void {
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

  return { connected, awaiting, subscribe, stop };
}
