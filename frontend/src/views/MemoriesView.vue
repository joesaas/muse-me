<script setup lang="ts">
// 记忆：记忆列表 / 批准 / 不记录 / 删除。
// 加载走统一三态；决策按钮只对 pending 显示（四维评审 FE-8，
// 后端 decide 只许 pending，rejected 再点必然 409）；
// 级别做 fact/inference/never 三值映射，never 不再标成「推测」。
import { onMounted } from "vue";
import { api } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import { memoryLevelLabel, memoryStatusLabel } from "../labels";
import type { MemoryItem } from "../types";

const memories = useAsyncList<MemoryItem>(() => api<MemoryItem[]>("/api/memories"));
const action = useActionState();

async function decide(m: MemoryItem, ok: boolean): Promise<void> {
  await action.runAction(`decide-${m.id}`, async () => {
    await api(`/api/memories/${m.id}/decide`, {
      method: "POST",
      body: JSON.stringify({ approved: ok }),
    });
    await memories.load();
  });
}

async function remove(m: MemoryItem): Promise<void> {
  await action.runAction(`remove-${m.id}`, async () => {
    await api(`/api/memories/${m.id}`, { method: "DELETE" });
    await memories.load();
  });
}

onMounted(memories.load);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>记忆</h2>
      <span class="muted">推测类记忆需审批后生效</span>
    </div>
    <p v-if="memories.loading.value" class="muted">正在加载记忆…</p>
    <p v-else-if="memories.error.value" class="err">
      记忆加载失败：{{ memories.error.value }} <button @click="memories.retry">重试</button>
    </p>
    <p v-else-if="!memories.items.value.length" class="muted">暂无记忆。</p>
    <div v-else class="cards">
      <div v-for="m in memories.items.value" :key="m.id" class="card">
        <p>{{ m.content }}</p>
        <p>
          <span class="tag">{{ memoryLevelLabel(m.level) }}</span>
          <span class="tag">{{ memoryStatusLabel(m.status) }}</span>
        </p>
        <div class="row">
          <template v-if="m.status === 'pending'">
            <button :disabled="action.busy.value !== null" @click="decide(m, true)">批准</button>
            <button :disabled="action.busy.value !== null" @click="decide(m, false)">不记录</button>
          </template>
          <button :disabled="action.busy.value !== null" @click="remove(m)">删除</button>
        </div>
      </div>
    </div>
    <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
  </section>
</template>
