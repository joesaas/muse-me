<script setup lang="ts">
// 聊天：话题列表 / 新话题 / 发送 / 停止 / SSE 流式气泡与工具提示。
// 流式恢复（四维评审 FE-3，遗留①根因）：落库消息是正本，
// 进行中运行的本地增量（工具提示行、系统提示行、流式气泡）
// 与落库消息合并渲染（streamItems.mergeDisplayItems），重拉不再整表覆盖；
// 运行 id、气泡文本与增量行还存 sessionStorage，组件重挂后也能恢复。
// 恢复路径只剩两条：挂载与窗口聚焦（onActivated 死代码已删，见 FE-4）。
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, apiErrorText } from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import { useRunStream } from "../composables/useRunStream";
import { toolLabel } from "../labels";
import type { Chat, Message, Run } from "../types";
import {
  isTerminalEventType,
  mergeDisplayItems,
  type DisplayItem,
} from "../streamItems";

const route = useRoute();
const router = useRouter();

const chatsList = useAsyncList<Chat>(() => api<Chat[]>("/api/chats"));
const items = ref<DisplayItem[]>([]);
const input = ref("");
const currentChat = ref<string | null>(null);
const currentRun = ref<string | null>(null);
const messagesEl = ref<HTMLElement | null>(null);
const messagesError = ref<string | null>(null);
const sending = ref(false);
const sendError = ref<string | null>(null);

let lastDbMessages: Message[] = [];

/** 进行中运行的本地视图：气泡 + 增量行，随流式事件累积。 */
interface LiveState {
  runId: string;
  bubble: DisplayItem;
  extras: DisplayItem[];
}
let live: LiveState | null = null;

const runKey = (chatId: string): string => `museme.run.${chatId}`;
const bubbleKey = (runId: string): string => `museme.bubble.${runId}`;
const extrasKey = (runId: string): string => `museme.extras.${runId}`;

function persistLive(): void {
  if (!live || !currentChat.value) return;
  sessionStorage.setItem(runKey(currentChat.value), live.runId);
  sessionStorage.setItem(
    bubbleKey(live.runId),
    live.bubble.kind === "msg" ? live.bubble.content : "",
  );
  sessionStorage.setItem(extrasKey(live.runId), JSON.stringify(live.extras));
}

function clearLiveStorage(runId: string, chatId: string | null): void {
  sessionStorage.removeItem(bubbleKey(runId));
  sessionStorage.removeItem(extrasKey(runId));
  if (chatId && sessionStorage.getItem(runKey(chatId)) === runId) {
    sessionStorage.removeItem(runKey(chatId));
  }
}

function restoreLive(chatId: string): void {
  const runId = sessionStorage.getItem(runKey(chatId));
  if (!runId) {
    live = null;
    return;
  }
  let extras: DisplayItem[] = [];
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(extrasKey(runId)) ?? "[]");
    if (Array.isArray(parsed)) {
      extras = parsed.filter(
        (it): it is DisplayItem =>
          !!it && typeof it === "object" && (it.kind === "msg" || it.kind === "tool"),
      );
    }
  } catch {
    extras = [];
  }
  const text = sessionStorage.getItem(bubbleKey(runId)) ?? "";
  live = { runId, bubble: { kind: "msg", role: "assistant", content: text }, extras };
}

function renderItems(): void {
  items.value = mergeDisplayItems(
    lastDbMessages,
    live ? { bubble: live.bubble, extras: live.extras } : null,
  );
}

function scrollMsgs(): void {
  void nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

const stream = useRunStream((e) => {
  if (e.type === "assistant_delta" && e.text) {
    if (live?.bubble.kind === "msg") {
      live.bubble.content += e.text;
      persistLive();
      renderItems();
    }
    scrollMsgs();
    return;
  }
  if (e.type === "tool_called") {
    if (live) {
      live.extras.push({
        kind: "tool",
        text: `用了工具：${toolLabel(e.tool)} ${e.summary ?? ""}`,
      });
      persistLive();
      renderItems();
    }
    scrollMsgs();
    return;
  }
  if (e.type === "approval_required") {
    if (live) {
      live.extras.push({
        kind: "msg",
        role: "system",
        content: "有一件事停在「待我确认」里等你拍板",
      });
      persistLive();
      renderItems();
    }
    scrollMsgs();
    return;
  }
  if (isTerminalEventType(e.type)) {
    if (live) {
      clearLiveStorage(live.runId, currentChat.value);
      live = null;
    }
    currentRun.value = null;
    void chatsList.load();
    void reloadMessages();
  }
});

async function reloadMessages(): Promise<void> {
  if (!currentChat.value) return;
  try {
    const msgs = await api<Message[]>(`/api/chats/${currentChat.value}/messages`);
    messagesError.value = null;
    lastDbMessages = msgs;
    renderItems();
  } catch (e) {
    messagesError.value = apiErrorText(e);
  }
}

async function openChat(id: string): Promise<void> {
  currentChat.value = id;
  live = null;
  restoreLive(id);
  await reloadMessages();
  // FeedView「基于此构建」留下的开场提示（建话题后直接追加一条 system 消息）。
  const hintKey = `museme.chatHint.${id}`;
  const hint = sessionStorage.getItem(hintKey);
  if (hint) {
    sessionStorage.removeItem(hintKey);
    items.value.push({ kind: "msg", role: "system", content: hint });
    scrollMsgs();
  }
  void chatsList.load();
}

async function selectChat(id: string): Promise<void> {
  if (route.params.id !== id) await router.push({ name: "chat-detail", params: { id } });
  else await openChat(id);
}

async function newChat(): Promise<void> {
  const c = await api<Chat>("/api/chats", {
    method: "POST",
    body: JSON.stringify({ kind: "side", title: "新话题" }),
  });
  await router.push({ name: "chat-detail", params: { id: c.id } });
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  sendError.value = null;
  const savedInput = text;
  input.value = "";
  let userItem: DisplayItem | null = null;
  let bubbleItem: DisplayItem | null = null;
  try {
    if (!currentChat.value) {
      const c = await api<Chat>("/api/chats", {
        method: "POST",
        body: JSON.stringify({ kind: "main", title: "主聊" }),
      });
      currentChat.value = c.id;
      await router.replace({ name: "chat-detail", params: { id: c.id } });
    }
    // 上一轮若仍在流式，先按落库重绘（旧本地视图不再是当前轮），再推本轮气泡。
    if (live) {
      live = null;
      renderItems();
    }
    userItem = { kind: "msg", role: "user", content: text };
    bubbleItem = { kind: "msg", role: "assistant", content: "" };
    items.value.push(userItem);
    items.value.push(bubbleItem);
    scrollMsgs();
    const { run_id } = await api<{ run_id: string }>(`/api/chats/${currentChat.value}/send`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    currentRun.value = run_id;
    live = { runId: run_id, bubble: bubbleItem, extras: [] };
    persistLive();
    stream.subscribe(run_id);
  } catch (e) {
    // 发送失败：回滚本轮推入的用户气泡与空气泡，恢复输入，提示重试（FE-7）。
    if (userItem || bubbleItem) {
      items.value = items.value.filter((it) => it !== userItem && it !== bubbleItem);
    }
    input.value = savedInput;
    sendError.value = apiErrorText(e);
  } finally {
    sending.value = false;
  }
}

async function stop(): Promise<void> {
  if (currentRun.value) {
    try {
      await api(`/api/runs/${currentRun.value}/cancel`, { method: "POST" });
    } catch {
      /* 取消失败时静默，运行终态会由事件流收口 */
    }
  }
}

// 从审批页返回 / 窗口重新聚焦 / 挂载恢复：先按落库重拉（合并本地增量），
// 再按本话题存档的运行 id 检查状态：仍在跑则从断点续订；已终态则清掉本地视图。
async function refreshOnReturn(): Promise<void> {
  if (!currentChat.value) return;
  await reloadMessages();
  const storedRun = sessionStorage.getItem(runKey(currentChat.value));
  if (!storedRun || stream.connected.value) return;
  try {
    const run = await api<Run>(`/api/runs/${storedRun}`);
    if (run.status === "running" || run.status === "awaiting_approval") {
      // 未终态：先恢复本地视图（气泡与增量行），仍在跑的才续订；
      // 等待审批的不订阅（等批准），只保留视图。
      if (!live || live.runId !== storedRun) restoreLive(currentChat.value);
      renderItems();
      if (run.status === "running") {
        currentRun.value = storedRun;
        stream.resume(storedRun);
      }
    } else if (["done", "failed", "cancelled"].includes(run.status)) {
      clearLiveStorage(storedRun, currentChat.value);
      live = null;
      await reloadMessages();
    }
  } catch {
    /* run 已不可见时静默 */
  }
}

function onFocus(): void {
  void refreshOnReturn();
}

watch(
  () => route.params.id,
  async (id) => {
    const target = typeof id === "string" ? id : null;
    if (target && target !== currentChat.value) {
      await openChat(target);
      await refreshOnReturn();
    }
  },
);

onMounted(async () => {
  window.addEventListener("focus", onFocus);
  await chatsList.load();
  const id = typeof route.params.id === "string" ? route.params.id : null;
  if (id) {
    await openChat(id);
    await refreshOnReturn();
  } else if (chatsList.items.value[0]) {
    await router.replace({ name: "chat-detail", params: { id: chatsList.items.value[0].id } });
  }
});

onUnmounted(() => window.removeEventListener("focus", onFocus));
</script>

<template>
  <section class="view">
    <div class="chat-wrap">
      <div class="chat-list">
        <button @click="newChat">＋ 新话题</button>
        <p v-if="chatsList.loading.value" class="muted">正在加载话题…</p>
        <p v-else-if="chatsList.error.value" class="err">
          话题加载失败：{{ chatsList.error.value }} <button @click="chatsList.retry">重试</button>
        </p>
        <ul v-else>
          <li
            v-for="c in chatsList.items.value"
            :key="c.id"
            :class="{ active: c.id === currentChat }"
            @click="selectChat(c.id)"
          >
            {{ c.title }}<small>{{ c.kind === "side" ? "新话题" : "主聊" }} · {{ c.updated_at }}</small>
          </li>
        </ul>
      </div>
      <div class="chat-pane">
        <p v-if="messagesError" class="err" style="margin: 10px 16px 0">
          消息加载失败：{{ messagesError }} <button @click="reloadMessages">重试</button>
        </p>
        <div ref="messagesEl" class="messages">
          <template v-for="(it, i) in items" :key="i">
            <div v-if="it.kind === 'msg'" class="msg" :class="it.role">{{ it.content }}</div>
            <div v-else class="tool">{{ it.text }}</div>
          </template>
        </div>
        <div class="composer">
          <textarea
            v-model="input"
            rows="2"
            placeholder="说你想做的事，例如：看到一条新闻想买里面的 meme，100 美元，先查流动性"
          ></textarea>
          <button :disabled="sending" @click="send">{{ sending ? "发送中…" : "发送" }}</button>
          <button class="ghost" @click="stop">停止</button>
        </div>
        <p v-if="sendError" class="err" style="margin: 0 12px 10px">{{ sendError }}，请重试</p>
      </div>
    </div>
  </section>
</template>
