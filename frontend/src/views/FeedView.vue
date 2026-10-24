<script setup lang="ts">
// 今日精选：列表 / 刷新 /「我想看什么」提示词查看·保存·回滚 / 追问 / 基于此构建。
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import type { Chat, FeedItem, PromptDoc } from "../types";

const router = useRouter();
const items = ref<FeedItem[]>([]);
const promptBoxOpen = ref(false);
const promptContent = ref("");
const promptNote = ref("");

async function loadFeed(): Promise<void> {
  items.value = await api<FeedItem[]>("/api/feed");
}

async function refresh(): Promise<void> {
  await api("/api/feed/refresh", { method: "POST" });
  await loadFeed();
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
  promptNote.value = "已保存为 v" + p.version;
  await loadFeed();
}

async function rollbackPrompt(): Promise<void> {
  const versions = await api<PromptDoc[]>("/api/prompts/feed/versions");
  const prev = versions[versions.length - 2];
  if (!prev) {
    alert("还没有上一版");
    return;
  }
  const p = await api<PromptDoc>("/api/prompts/feed/rollback", {
    method: "POST",
    body: JSON.stringify({ version: prev.version }),
  });
  promptContent.value = p.content;
  promptNote.value = "已回到旧内容，存为 v" + p.version;
  await loadFeed();
}

async function startChat(item: FeedItem, act: "ask" | "build"): Promise<void> {
  const payload =
    act === "build"
      ? { kind: "side", feed_item_id: item.id, title: "构建脚本", scene: "script_build" }
      : { kind: "side", feed_item_id: item.id, title: "精选追问" };
  const c = await api<Chat>("/api/chats", { method: "POST", body: JSON.stringify(payload) });
  if (act === "build") {
    sessionStorage.setItem(
      `museme.chatHint.${c.id}`,
      "已把这条精选带进来。直接说你想做什么，例如：买这个 meme，100 美元，先查流动性。",
    );
  }
  await router.push({ name: "chat-detail", params: { id: c.id } });
}

onMounted(loadFeed);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>今日精选</h2>
      <button class="ghost" @click="togglePrompt">我想看什么</button>
      <button @click="refresh">刷新精选</button>
    </div>
    <div v-if="promptBoxOpen" class="card">
      <label>我想看什么（提示词，保存后生成新版本）</label>
      <textarea v-model="promptContent" rows="4"></textarea>
      <div class="row">
        <button @click="savePrompt">保存</button>
        <button class="ghost" @click="rollbackPrompt">回到上一版</button>
        <span class="muted">{{ promptNote }}</span>
      </div>
    </div>
    <div class="cards">
      <div v-for="f in items" :key="f.id" class="card">
        <h3>{{ f.title }}</h3>
        <p>{{ f.summary }}</p>
        <p>
          <span v-for="(e, i) in f.entities || []" :key="i" class="tag">{{ e.label || e.value }}</span>
        </p>
        <p class="muted">{{ f.source }} · {{ f.published_at }}</p>
        <div class="row">
          <button @click="startChat(f, 'ask')">追问</button>
          <button @click="startChat(f, 'build')">基于此构建脚本</button>
        </div>
      </div>
    </div>
  </section>
</template>
