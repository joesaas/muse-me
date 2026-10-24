<script setup lang="ts">
// 账号与连接：连接状态列表（只读展示，与旧版一致）。
import { onMounted, ref } from "vue";
import { api } from "../api";
import type { Connection } from "../types";

const list = ref<Connection[]>([]);

async function loadConnections(): Promise<void> {
  list.value = await api<Connection[]>("/api/settings/connections");
}

onMounted(loadConnections);
</script>

<template>
  <section class="view">
    <div class="bar"><h2>账号与连接</h2></div>
    <div class="cards">
      <div v-for="c in list" :key="c.name" class="card">
        <h3>{{ c.name }}</h3>
        <p>{{ c.status }}</p>
        <p class="muted">{{ c.detail }}</p>
      </div>
    </div>
  </section>
</template>
