// 全局会话状态：登录态 + 待审批角标。
// 角标在登录后每 30 秒轮询一次，登出即停；approval_required 事件也会触发即时刷新。
import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../api";
import type { Approval } from "../types";

const BADGE_INTERVAL_MS = 30_000;

export const useAppStore = defineStore("app", () => {
  const authed = ref<boolean | null>(null); // null = 尚未探测
  const pendingCount = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refreshBadge(): Promise<void> {
    try {
      const list = await api<Approval[]>("/api/approvals");
      pendingCount.value = list.filter((a) => a.status === "pending").length;
    } catch {
      /* 未登录或网络抖动时静默，下轮再试 */
    }
  }

  function startBadgePolling(): void {
    if (timer) return;
    void refreshBadge();
    timer = setInterval(() => void refreshBadge(), BADGE_INTERVAL_MS);
  }

  function stopBadgePolling(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function setLoggedIn(): void {
    authed.value = true;
    startBadgePolling();
  }

  function setLoggedOut(): void {
    authed.value = false;
    pendingCount.value = 0;
    stopBadgePolling();
  }

  return {
    authed,
    pendingCount,
    refreshBadge,
    startBadgePolling,
    stopBadgePolling,
    setLoggedIn,
    setLoggedOut,
  };
});
