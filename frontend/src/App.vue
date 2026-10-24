<script setup lang="ts">
// 顶层布局：登录门 + 侧栏菜单（六个一级小白名 +「更多」三项）+ RouterView。
// 登录态由 Pinia store 持有；登录探测只把 401 当作未登录，
// 其它错误（500/断网）显示「服务暂时连不上」而不是误判为未登录（四维评审 FE-12）。
// 菜单高亮按路径前缀判定（四维评审 FE-4 选型）：/chat 与 /chat/:id 是同级路由记录，
// RouterLink 的 isActive 按记录包含判定必然在详情页不亮，改前缀判定后详情页也亮。
import { onMounted, ref } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { api, ApiError } from "./api";
import { useAppStore } from "./stores/app";
import type { Chat } from "./types";

const store = useAppStore();
const route = useRoute();
const password = ref("");
const loginErr = ref("");
const probeError = ref(false);

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

function isMenuActive(to: string): boolean {
  return route.path === to || route.path.startsWith(to + "/");
}

async function probe(): Promise<void> {
  probeError.value = false;
  try {
    await api<Chat[]>("/api/chats");
    store.setLoggedIn();
  } catch (e) {
    // 401 已由 api 层触发登录门（setLoggedOut）；其它错误不是未登录。
    if (!(e instanceof ApiError && e.status === 401)) probeError.value = true;
  }
}

onMounted(probe);

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
      <p>输入口令进入（演示默认口令 demo）</p>
      <input v-model="password" type="password" placeholder="口令" @keyup.enter="login">
      <button @click="login">进入</button>
      <p class="err">{{ loginErr }}</p>
    </div>
  </div>

  <div v-else-if="probeError" class="login">
    <div class="login-card">
      <h1>我的个人助手</h1>
      <p>服务暂时连不上，请稍后再试。</p>
      <button @click="probe">重试</button>
    </div>
  </div>

  <div v-else-if="store.authed" class="layout">
    <aside class="side">
      <div class="brand">我的个人助手</div>
      <nav>
        <RouterLink v-for="m in mainMenu" :key="m.to" :to="m.to" custom v-slot="{ navigate }">
          <button :class="{ active: isMenuActive(m.to) }" @click="navigate">
            {{ m.label }}
            <span v-if="m.badge && store.pendingCount" class="badge">{{ store.pendingCount }}</span>
          </button>
        </RouterLink>
      </nav>
      <div class="more">
        <div class="more-title">更多</div>
        <RouterLink v-for="m in moreMenu" :key="m.to" :to="m.to" custom v-slot="{ navigate }">
          <button :class="{ active: isMenuActive(m.to) }" @click="navigate">{{ m.label }}</button>
        </RouterLink>
      </div>
    </aside>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
