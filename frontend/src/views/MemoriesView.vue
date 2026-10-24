<script setup lang="ts">
// 它记得的事：记忆列表 / 批准记住 / 不要记 / 删掉。
import { onMounted, ref } from "vue";
import { api } from "../api";
import type { MemoryItem } from "../types";

const list = ref<MemoryItem[]>([]);

async function loadMemories(): Promise<void> {
  list.value = await api<MemoryItem[]>("/api/memories");
}

async function decide(m: MemoryItem, ok: boolean): Promise<void> {
  await api(`/api/memories/${m.id}/decide`, {
    method: "POST",
    body: JSON.stringify({ approved: ok }),
  });
  await loadMemories();
}

async function remove(m: MemoryItem): Promise<void> {
  await api(`/api/memories/${m.id}`, { method: "DELETE" });
  await loadMemories();
}

onMounted(loadMemories);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>它记得的事</h2>
      <span class="muted">推测类的内容要你批准后才算数</span>
    </div>
    <div class="cards">
      <div v-for="m in list" :key="m.id" class="card">
        <p>{{ m.content }}</p>
        <p>
          <span class="tag">{{ m.level === "fact" ? "事实" : "推测" }}</span>
          <span class="tag">{{ m.status === "active" ? "已生效" : m.status === "rejected" ? "已拒绝" : "等你批准" }}</span>
        </p>
        <div class="row">
          <template v-if="m.status !== 'active'">
            <button @click="decide(m, true)">批准记住</button>
            <button @click="decide(m, false)">不要记</button>
          </template>
          <button @click="remove(m)">删掉</button>
        </div>
      </div>
      <p v-if="!list.length" class="muted">它还没有记住任何事。</p>
    </div>
  </section>
</template>
