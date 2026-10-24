<script setup lang="ts">
// 执行记录：运行列表 + 单条回放（事件序列文本）。
// 加载与回放走统一三态/动作容错；状态、类别、事件类型只经 labels.ts 人话映射渲染。
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import { eventTypeLabel, runKindLabel, runStatusLabel } from "../labels";
import type { Run } from "../types";

const runs = useAsyncList<Run>(() => api<Run[]>("/api/runs"));
const action = useActionState();
const detail = ref<Run | null>(null);

const detailText = computed(() =>
  (detail.value?.events || [])
    .map((e) => `${e.ts ?? ""} ${eventTypeLabel(e.type)} ${e.summary ?? ""}`)
    .join("\n"),
);

async function show(r: Run): Promise<void> {
  await action.runAction(`show-${r.id}`, async () => {
    detail.value = await api<Run>(`/api/runs/${r.id}`);
  });
}

onMounted(runs.load);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>执行记录</h2>
      <button class="ghost" @click="runs.load">刷新</button>
    </div>
    <p v-if="runs.loading.value" class="muted">正在加载执行记录…</p>
    <p v-else-if="runs.error.value" class="err">
      执行记录加载失败：{{ runs.error.value }} <button @click="runs.retry">重试</button>
    </p>
    <p v-else-if="!runs.items.value.length" class="muted">还没有执行记录。</p>
    <div v-else class="cards">
      <div v-for="r in runs.items.value" :key="r.id" class="card">
        <h3>{{ r.title || runKindLabel(r.kind) }}</h3>
        <p>状态：{{ runStatusLabel(r.status) }} · 花费：${{ r.cost_usd ?? 0 }}</p>
        <p class="muted">{{ r.created_at }}</p>
        <div class="row"><button :disabled="action.busy.value !== null" @click="show(r)">回放</button></div>
      </div>
    </div>
    <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
    <div v-if="detail" class="card" style="margin-top: 12px">
      <h3>回放：{{ detail.title }}</h3>
      <pre>{{ detailText }}</pre>
    </div>
  </section>
</template>
