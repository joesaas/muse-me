<script setup lang="ts">
// 账号与连接：连接状态列表（只读展示）。
// 加载走统一三态；连接状态只经 labels.ts 人话映射渲染，
// 后端拼入的 not_configured 不再直出。
import { onMounted } from "vue";
import { api } from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import { connectionStatusLabel } from "../labels";
import type { Connection } from "../types";

const connections = useAsyncList<Connection>(() => api<Connection[]>("/api/settings/connections"));

onMounted(connections.load);
</script>

<template>
  <section class="view">
    <div class="bar"><h2>账号与连接</h2></div>
    <p v-if="connections.loading.value" class="muted">正在加载连接状态…</p>
    <p v-else-if="connections.error.value" class="err">
      连接状态加载失败：{{ connections.error.value }} <button @click="connections.retry">重试</button>
    </p>
    <p v-else-if="!connections.items.value.length" class="muted">还没有连接信息。</p>
    <div v-else class="cards">
      <div v-for="c in connections.items.value" :key="c.name" class="card">
        <h3>{{ c.name }}</h3>
        <p>{{ connectionStatusLabel(c.status) }}</p>
        <p class="muted">{{ c.detail }}</p>
      </div>
    </div>
  </section>
</template>
