<script setup lang="ts">
// 定时任务：列表 / 触发描述 / 启停。
// 加载走统一三态；最近结果与触发操作符只经 labels.ts 人话映射渲染。
import { onMounted } from "vue";
import { api } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import { jobLastStatusLabel, triggerOpLabel } from "../labels";
import type { Job, Trigger } from "../types";

const jobs = useAsyncList<Job>(() => api<Job[]>("/api/jobs"));
const action = useActionState();

function describeTrigger(t: Trigger | undefined): string {
  if (!t) return "-";
  if (t.type === "time") return t.cron_daily ? `每天 ${t.cron_daily}` : `每 ${t.every_minutes ?? "?"} 分钟`;
  if (t.type === "event") return `精选出现「${t.keyword}」时`;
  return `${t.metric} ${triggerOpLabel(t.op)} ${t.threshold} 时`;
}

async function toggle(j: Job): Promise<void> {
  await action.runAction(`toggle-${j.id}`, async () => {
    await api(`/api/jobs/${j.id}/toggle`, { method: "POST" });
    await jobs.load();
  });
}

onMounted(jobs.load);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>定时任务</h2>
      <span class="muted">到点自动运行你保存的脚本</span>
    </div>
    <p v-if="jobs.loading.value" class="muted">正在加载定时任务…</p>
    <p v-else-if="jobs.error.value" class="err">
      定时任务加载失败：{{ jobs.error.value }} <button @click="jobs.retry">重试</button>
    </p>
    <p v-else-if="!jobs.items.value.length" class="muted">还没有定时任务。在「我的脚本」里把脚本设为定时任务即可。</p>
    <div v-else class="cards">
      <div v-for="j in jobs.items.value" :key="j.id" class="card">
        <h3>{{ j.name }}</h3>
        <p>触发：{{ describeTrigger(j.trigger) }} · 状态：{{ j.enabled ? "进行中" : "已暂停" }}</p>
        <p class="muted">下次运行：{{ j.next_run_at ?? "-" }} · 最近结果：{{ jobLastStatusLabel(j.last_status) }}</p>
        <div class="row">
          <button :disabled="action.busy.value !== null" @click="toggle(j)">{{ j.enabled ? "暂停" : "恢复" }}</button>
        </div>
      </div>
    </div>
    <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
  </section>
</template>
