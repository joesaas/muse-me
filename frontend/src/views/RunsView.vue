<script setup lang="ts">
// 执行记录：运行列表 + 单条回放（事件序列文本，与旧版一致）。
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import type { Run } from "../types";

const list = ref<Run[]>([]);
const detail = ref<Run | null>(null);

const detailText = computed(() =>
  (detail.value?.events || [])
    .map((e) => `${e.ts ?? ""} ${e.type} ${e.summary ?? ""}`)
    .join("\n"),
);

async function loadRuns(): Promise<void> {
  list.value = await api<Run[]>("/api/runs");
}

async function show(r: Run): Promise<void> {
  detail.value = await api<Run>(`/api/runs/${r.id}`);
}

onMounted(loadRuns);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>执行记录</h2>
      <button class="ghost" @click="loadRuns">刷新</button>
    </div>
    <div class="cards">
      <div v-for="r in list" :key="r.id" class="card">
        <h3>{{ r.title || r.kind }}</h3>
        <p>状态：{{ r.status }} · 花费：${{ r.cost_usd ?? 0 }}</p>
        <p class="muted">{{ r.created_at }}</p>
        <div class="row"><button @click="show(r)">回放</button></div>
      </div>
    </div>
    <div v-if="detail" class="card" style="margin-top: 12px">
      <h3>回放：{{ detail.title }}</h3>
      <pre>{{ detailText }}</pre>
    </div>
  </section>
</template>
