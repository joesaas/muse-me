<script setup lang="ts">
// 顶层布局：登录门 + 侧栏菜单（六个一级小白名 +「更多」三项）+ RouterView。
// 登录态由 Pinia store 持有；探测失败（401）即显示登录门，与旧版 boot() 行为等价。
import { onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { api } from "./api";
import { useAppStore } from "./stores/app";
import type { Chat } from "./types";

const store = useAppStore();
const password = ref("");
const loginErr = ref("");

const mainMenu = [
  { to: "/chat", label: "💬 聊天" },
  { to: "/feed", label: "📰 今日精选" },
  { to: "/scripts", label: "🧰 我的脚本" },
  { to: "/jobs", label: "⏰ 定时任务" },
  { to: "/approvals", label: "✅ 待我确认", badge: true },
  { to: "/files", label: "📁 我的文件" },
];
const moreMenu = [
  { to: "/runs", label: "📜 执行记录" },
  { to: "/memories", label: "🧠 它记得的事" },
  { to: "/settings", label: "🔗 账号与连接" },
];

onMounted(async () => {
  try {
    await api<Chat[]>("/api/chats");
    store.setLoggedIn();
  } catch {
    store.setLoggedOut();
  }
});

async function login(): Promise<void> {
  loginErr.value = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: password.value }),
    });
    password.value = "";
    store.setLoggedIn();
  } catch {
    loginErr.value = "口令不对，再试试";
  }
}
</script>

<template>
  <div v-if="store.authed === false" class="login">
    <div class="login-card">
      <h1>我的个人助手</h1>
      <p>输入口令进入（演示默认口令 demo，可在启动时用环境变量改）</p>
      <input v-model="password" type="password" placeholder="口令" @keyup.enter="login">
      <button @click="login">进入</button>
      <p class="err">{{ loginErr }}</p>
    </div>
  </div>

  <div v-else-if="store.authed" class="layout">
    <aside class="side">
      <div class="brand">我的个人助手</div>
      <nav>
        <RouterLink v-for="m in mainMenu" :key="m.to" :to="m.to" custom v-slot="{ navigate, isActive }">
          <button :class="{ active: isActive }" @click="navigate">
            {{ m.label }}
            <span v-if="m.badge && store.pendingCount" class="badge">{{ store.pendingCount }}</span>
          </button>
        </RouterLink>
      </nav>
      <div class="more">
        <div class="more-title">更多</div>
        <RouterLink v-for="m in moreMenu" :key="m.to" :to="m.to" custom v-slot="{ navigate, isActive }">
          <button :class="{ active: isActive }" @click="navigate">{{ m.label }}</button>
        </RouterLink>
      </div>
    </aside>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
