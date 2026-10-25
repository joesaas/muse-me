<script setup lang="ts">
// 今日精选：列表 / 刷新 /「精选偏好」提示词查看·保存·回滚 / 追问 / 基于此构建。
// 加载走统一三态（useAsyncList）：加载中 / 失败重试 / 空态三分流，
// 失败时不再渲染空白卡片区。
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import { relativeTimeLabel } from "../labels";
import type { Chat, FeedItem, PromptDoc } from "../types";

const router = useRouter();
const feed = useAsyncList<FeedItem>(() => api<FeedItem[]>("/api/feed"));
const promptBoxOpen = ref(false);
const promptContent = ref("");
const promptNote = ref("");

async function refresh(): Promise<void> {
  await api("/api/feed/refresh", { method: "POST" });
  await feed.load();
}

async function togglePrompt(): Promise<void> {
  const p = await api<PromptDoc>("/api/prompts/feed");
  promptContent.value = p.content;
  promptNote.value = "当前版本 v" + p.version;
  promptBoxOpen.value = !promptBoxOpen.value;
}

async function savePrompt(): Promise<void> {
  const p = await api<PromptDoc>("/api/prompts/feed", {
    method: "PUT",
    body: JSON.stringify({ content: promptContent.value }),
  });
  promptNote.value = "已保存，当前版本 v" + p.version;
  await feed.load();
}

async function rollbackPrompt(): Promise<void> {
  // 按 version 数值找当前版本的上一版（四维评审 FE-10），
  // 不再假设 versions 数组的顺序（旧代码取倒数第二位）。
  const [current, versions] = await Promise.all([
    api<PromptDoc>("/api/prompts/feed"),
    api<PromptDoc[]>("/api/prompts/feed/versions"),
  ]);
  const older = versions
    .filter((v) => v.version < current.version)
    .sort((a, b) => b.version - a.version);
  const prev = older[0];
  if (!prev) {
    alert("暂无上一版本");
    return;
  }
  const p = await api<PromptDoc>("/api/prompts/feed/rollback", {
    method: "POST",
    body: JSON.stringify({ version: prev.version }),
  });
  promptContent.value = p.content;
  promptNote.value = "已回滚至上一版本，当前版本 v" + p.version;
  await feed.load();
}

// 时间写法见映射表 relativeTimeLabel（截图版式的相对时间，右栏复用同一口径）。

function sourceInitial(item: FeedItem): string {
  return (item.source?.trim().charAt(0) ?? "") || "精";
}

async function startChat(item: FeedItem, act: "ask" | "build"): Promise<void> {
  const payload =
    act === "build"
      ? { kind: "side", feed_item_id: item.id, title: "构建插件", scene: "script_build" }
      : { kind: "side", feed_item_id: item.id, title: "精选追问" };
  const c = await api<Chat>("/api/chats", { method: "POST", body: JSON.stringify(payload) });
  if (act === "build") {
    sessionStorage.setItem(
      `museme.chatHint.${c.id}`,
      "已载入该条精选。请描述你的需求，例如：买入该 meme，100 美元，并先核查流动性。",
    );
  }
  await router.push({ name: "chat-detail", params: { id: c.id } });
}

onMounted(feed.load);
</script>

<template>
  <section class="view feed-col">
    <div class="bar">
      <h2>今日精选</h2>
      <button class="ghost" @click="togglePrompt">精选偏好</button>
      <button @click="refresh">刷新精选</button>
    </div>
    <div v-if="promptBoxOpen" class="card">
      <label>精选偏好（提示词，保存后生成新版本）</label>
      <textarea v-model="promptContent" rows="4"></textarea>
      <div class="row">
        <button @click="savePrompt">保存</button>
        <button class="ghost" @click="rollbackPrompt">回滚至上一版</button>
        <span class="muted">{{ promptNote }}</span>
      </div>
    </div>
    <p v-if="feed.loading.value" class="muted">正在加载精选…</p>
    <p v-else-if="feed.error.value" class="err">
      精选加载失败：{{ feed.error.value }} <button @click="feed.retry">重试</button>
    </p>
    <p v-else-if="!feed.items.value.length" class="muted">暂无今日精选，请点击「刷新精选」。</p>
    <div v-else>
      <article v-for="f in feed.items.value" :key="f.id" class="feed-item">
        <div class="feed-head">
          <span class="feed-avatar" :title="f.source ?? ''">{{ sourceInitial(f) }}</span>
          <h3 class="feed-title">{{ f.title }}</h3>
          <span class="feed-time">{{ relativeTimeLabel(f.published_at) }}</span>
        </div>
        <p class="feed-summary">{{ f.summary }}</p>
        <p v-if="(f.entities || []).length" class="feed-tags">
          <span v-for="(e, i) in f.entities || []" :key="i" class="tag">{{ e.label || e.value }}</span>
        </p>
        <p v-if="f.source" class="muted feed-meta">{{ f.source }}</p>
        <div class="feed-actions">
          <button class="quiet" @click="startChat(f, 'ask')">💬 追问</button>
          <button @click="startChat(f, 'build')">基于此构建插件</button>
        </div>
      </article>
    </div>
  </section>
</template>
