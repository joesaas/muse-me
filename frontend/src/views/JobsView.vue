<script setup lang="ts">
// 定时任务：列表 / 触发描述 / 启停。
import { onMounted, ref } from "vue";
import { api } from "../api";
import type { Job, Trigger } from "../types";

const list = ref<Job[]>([]);

function describeTrigger(t: Trigger | undefined): string {
  if (!t) return "-";
  if (t.type === "time") return t.cron_daily ? `每天 ${t.cron_daily}` : `每 ${t.every_minutes ?? "?"} 分钟`;
  if (t.type === "event") return `精选出现「${t.keyword}」时`;
  return `${t.metric} ${t.op} ${t.threshold} 时`;
}

async function loadJobs(): Promise<void> {
  list.value = await api<Job[]>("/api/jobs");
}

async function toggle(j: Job): Promise<void> {
  await api(`/api/jobs/${j.id}/toggle`, { method: "POST" });
  await loadJobs();
}

onMounted(loadJobs);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>定时任务</h2>
      <span class="muted">到点自动运行你保存的脚本</span>
    </div>
    <div class="cards">
      <div v-for="j in list" :key="j.id" class="card">
        <h3>{{ j.name }}</h3>
        <p>触发：{{ describeTrigger(j.trigger) }} · 状态：{{ j.enabled ? "进行中" : "已暂停" }}</p>
        <p class="muted">下次运行：{{ j.next_run_at ?? "-" }} · 最近结果：{{ j.last_status ?? "还没跑过" }}</p>
        <div class="row">
          <button @click="toggle(j)">{{ j.enabled ? "暂停" : "恢复" }}</button>
        </div>
      </div>
      <p v-if="!list.length" class="muted">还没有定时任务。在「我的脚本」里把脚本设为定时任务即可。</p>
    </div>
  </section>
</template>
