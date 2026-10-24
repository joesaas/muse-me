<script setup lang="ts">
// 聊天：话题列表 / 新话题 / 发送 / 停止 / SSE 流式气泡与工具提示。
// 从旧 app.ts 逐项迁移；流式改走 useRunStream（断线重连）。
// 续跑可见性：审批在别的页面批准后，本视图在重新激活/窗口聚焦时
// 重新拉取已落库的消息，并按 run 状态决定是否重新订阅事件流。
import { nextTick, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useRunStream } from "../composables/useRunStream";
import type { Chat, Message, Run } from "../types";

type DisplayItem =
  | { kind: "msg"; role: string; content: string }
  | { kind: "tool"; text: string };

const route = useRoute();
const router = useRouter();

const chats = ref<Chat[]>([]);
const items = ref<DisplayItem[]>([]);
const input = ref("");
const currentChat = ref<string | null>(null);
const currentRun = ref<string | null>(null);
const messagesEl = ref<HTMLElement | null>(null);
let bubble: DisplayItem | null = null;

function scrollMsgs(): void {
  void nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

const stream = useRunStream((e) => {
  if (e.type === "assistant_delta" && e.text) {
    if (bubble && bubble.kind === "msg") bubble.content += e.text;
    scrollMsgs();
  }
  if (e.type === "tool_called") {
    items.value.push({ kind: "tool", text: `用了工具：${e.tool ?? ""} ${e.summary ?? ""}` });
    scrollMsgs();
  }
  if (e.type === "approval_required") {
    items.value.push({ kind: "msg", role: "sys", content: "有一件事停在「待我确认」里等你拍板" });
    scrollMsgs();
  }
  if (["run_done", "run_failed", "run_cancelled"].includes(e.type)) {
    void loadChats();
    void reloadMessages();
  }
});

async function loadChats(): Promise<void> {
  chats.value = await api<Chat[]>("/api/chats");
}

async function reloadMessages(): Promise<void> {
  if (!currentChat.value) return;
  const msgs = await api<Message[]>(`/api/chats/${currentChat.value}/messages`);
  bubble = null;
  items.value = msgs.map((m) => ({ kind: "msg" as const, role: m.role, content: m.content }));
  scrollMsgs();
}

async function openChat(id: string): Promise<void> {
  currentChat.value = id;
  bubble = null;
  await reloadMessages();
  // FeedView「基于此构建」留下的开场提示（旧版在建话题后直接追加一条 sys 消息）。
  const hintKey = `museme.chatHint.${id}`;
  const hint = sessionStorage.getItem(hintKey);
  if (hint) {
    sessionStorage.removeItem(hintKey);
    items.value.push({ kind: "msg", role: "sys", content: hint });
    scrollMsgs();
  }
  void loadChats();
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
  if (!text) return;
  if (!currentChat.value) {
    const c = await api<Chat>("/api/chats", {
      method: "POST",
      body: JSON.stringify({ kind: "main", title: "主聊" }),
    });
    currentChat.value = c.id;
    await router.replace({ name: "chat-detail", params: { id: c.id } });
  }
  input.value = "";
  items.value.push({ kind: "msg", role: "user", content: text });
  bubble = { kind: "msg", role: "assistant", content: "" };
  items.value.push(bubble);
  scrollMsgs();
  const { run_id } = await api<{ run_id: string }>(`/api/chats/${currentChat.value}/send`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  currentRun.value = run_id;
  stream.subscribe(run_id);
}

async function stop(): Promise<void> {
  if (currentRun.value) await api(`/api/runs/${currentRun.value}/cancel`, { method: "POST" });
}

// 从审批页返回/窗口重新聚焦：拉取落库消息（含续跑产生的新消息），
// 若最近一轮 run 仍在跑则重新订阅事件流。
async function refreshOnReturn(): Promise<void> {
  if (!currentChat.value) return;
  await reloadMessages();
  if (currentRun.value && !stream.connected.value) {
    try {
      const run = await api<Run>(`/api/runs/${currentRun.value}`);
      if (run.status === "running") stream.subscribe(currentRun.value);
    } catch {
      /* run 已不可见时静默 */
    }
  }
}

function onFocus(): void {
  void refreshOnReturn();
}

watch(
  () => route.params.id,
  async (id) => {
    const target = typeof id === "string" ? id : null;
    if (target && target !== currentChat.value) await openChat(target);
  },
);

onMounted(async () => {
  window.addEventListener("focus", onFocus);
  await loadChats();
  const id = typeof route.params.id === "string" ? route.params.id : null;
  if (id) await openChat(id);
  else if (chats.value[0]) await router.replace({ name: "chat-detail", params: { id: chats.value[0].id } });
});

onActivated(() => void refreshOnReturn());
onUnmounted(() => window.removeEventListener("focus", onFocus));
</script>

<template>
  <section class="view">
    <div class="chat-wrap">
      <div class="chat-list">
        <button @click="newChat">＋ 新话题</button>
        <ul>
          <li
            v-for="c in chats"
            :key="c.id"
            :class="{ active: c.id === currentChat }"
            @click="selectChat(c.id)"
          >
            {{ c.title }}<small>{{ c.kind === "side" ? "新话题" : "主聊" }} · {{ c.updated_at }}</small>
          </li>
        </ul>
      </div>
      <div class="chat-pane">
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
          <button @click="send">发送</button>
          <button class="ghost" @click="stop">停止</button>
        </div>
      </div>
    </div>
  </section>
</template>
