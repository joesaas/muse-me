<script setup lang="ts">
// 右栏：审批 / 运行历史 / 个人指纹。
// 三个区的数据源与对应整页完全一致（同一接口、同一人话映射），右栏只做摘要与快捷操作，
// 详情仍进整页；窄屏下整栏由 CSS 隐藏，不挤中间对话。
// 审批：待处理可直接批准/拒绝（拒绝要理由，与审批页等价），已决只列最近 3 条。
// 运行历史：最近 5 条，表头挂「定时任务」入口（定时任务不再占左栏）。
// 个人指纹：记忆（生效中的前 5 条）+ 账号连接状态，入口分别进 /memories 与 /settings。
import { computed, onMounted, onUnmounted } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import {
  approvalStatusLabel,
  connectionStatusLabel,
  memoryLevelLabel,
  relativeTimeLabel,
  riskLabel,
  runKindLabel,
  runStatusLabel,
} from "../labels";
import { useAppStore } from "../stores/app";
import type { Approval, Connection, MemoryItem, Run } from "../types";

const store = useAppStore();
const approvals = useAsyncList<Approval>(() => api<Approval[]>("/api/approvals"));
const runs = useAsyncList<Run>(() => api<Run[]>("/api/runs"));
const memories = useAsyncList<MemoryItem>(() => api<MemoryItem[]>("/api/memories"));
const connections = useAsyncList<Connection>(() => api<Connection[]>("/api/settings/connections"));
const action = useActionState();

// 状态 pill 配色：只按原始 status 分档，不改动状态本身的语义。
function statusPillClass(status: string): string {
  if (status === "ok" || status === "connected") return "pill pill-ok";
  if (status === "error" || status === "failed") return "pill pill-bad";
  return "pill pill-neutral";
}

// 仅展示层面的数字收敛：把 3 位以上小数的数字抹成 2 位（如余额 4900.000324724 → 4900.00），
// 不改动任何业务数值，只让卡片里的数字可读。
function formatDetail(detail: string): string {
  return detail.replace(/\d+\.\d{3,}/g, (m) => parseFloat(m).toFixed(2));
}

const pending = computed(() => approvals.items.value.filter((a) => a.status === "pending"));
const decided = computed(() =>
  approvals.items.value.filter((a) => a.status !== "pending").slice(0, 3),
);
const recentRuns = computed(() => runs.items.value.slice(0, 5));
const activeMemories = computed(() =>
  memories.items.value.filter((m) => m.status === "active").slice(0, 5),
);

async function loadAll(): Promise<void> {
  await Promise.all([approvals.load(), runs.load(), memories.load(), connections.load()]);
}

async function decide(a: Approval, ok: boolean): Promise<void> {
  const reason = ok ? "" : prompt("请输入拒绝理由（可选）") || "";
  await action.runAction(`decide-${a.id}`, async () => {
    await api(`/api/approvals/${a.id}/decide`, {
      method: "POST",
      body: JSON.stringify({ approved: ok, reason }),
    });
    await approvals.load();
    void store.refreshBadge();
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void loadAll();
  timer = setInterval(() => void loadAll(), 30_000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <aside class="right">
    <section class="rsec">
      <div class="rhead">
        <h3>审批<span v-if="pending.length" class="badge">{{ pending.length }}</span></h3>
        <RouterLink to="/approvals">全部 →</RouterLink>
      </div>
      <p v-if="approvals.loading.value" class="muted">正在加载…</p>
      <p v-else-if="approvals.error.value" class="err">
        加载失败：{{ approvals.error.value }} <button @click="approvals.retry">重试</button>
      </p>
      <template v-else>
        <p v-if="!pending.length" class="muted">暂无待审批事项。</p>
        <div v-for="a in pending" :key="a.id" class="ritem">
          <h4>{{ a.title }}</h4>
          <p v-if="a.detail">{{ a.detail }}</p>
          <p>
            <span v-if="a.amount_usd" class="tag risk">金额 ${{ a.amount_usd }}</span>
            <span class="tag">{{ riskLabel(a.risk_level) }}</span>
          </p>
          <div class="rrow">
            <button :disabled="action.busy.value !== null" @click="decide(a, true)">批准</button>
            <button :disabled="action.busy.value !== null" @click="decide(a, false)">拒绝</button>
          </div>
        </div>
        <p v-if="decided.length" class="rsub">最近已决</p>
        <div v-for="a in decided" :key="a.id" class="ritem muted-item">
          <h4>{{ a.title }}</h4>
          <p>{{ approvalStatusLabel(a.status) }}</p>
        </div>
        <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
      </template>
    </section>

    <section class="rsec">
      <div class="rhead">
        <h3>运行历史</h3>
        <span><RouterLink to="/jobs">定时任务 →</RouterLink> · <RouterLink to="/runs">全部 →</RouterLink></span>
      </div>
      <p v-if="runs.loading.value" class="muted">正在加载…</p>
      <p v-else-if="runs.error.value" class="err">
        加载失败：{{ runs.error.value }} <button @click="runs.retry">重试</button>
      </p>
      <p v-else-if="!recentRuns.length" class="muted">暂无运行记录。</p>
      <div v-for="r in recentRuns" :key="r.id" class="ritem">
        <h4>{{ r.title || runKindLabel(r.kind) }}</h4>
        <p>
          {{ runStatusLabel(r.status) }} · 花费 ${{ r.cost_usd ?? 0
          }}<span v-if="r.created_at"> · {{ relativeTimeLabel(r.created_at) }}</span>
        </p>
      </div>
    </section>

    <section class="rsec">
      <div class="rhead">
        <h3>个人指纹</h3>
        <span><RouterLink to="/memories">记忆 →</RouterLink> · <RouterLink to="/settings">账号与连接 →</RouterLink></span>
      </div>
      <p v-if="memories.loading.value || connections.loading.value" class="muted">正在加载…</p>
      <p v-else-if="memories.error.value" class="err">
        记忆加载失败：{{ memories.error.value }} <button @click="memories.retry">重试</button>
      </p>
      <template v-else>
        <p v-if="!activeMemories.length" class="muted">暂无生效记忆。</p>
        <div v-for="m in activeMemories" :key="m.id" class="ritem">
          <p>{{ m.content }}</p>
          <p class="muted">{{ memoryLevelLabel(m.level) }}</p>
        </div>
      </template>
      <p v-if="connections.error.value" class="err">
        连接加载失败：{{ connections.error.value }} <button @click="connections.retry">重试</button>
      </p>
      <div v-for="c in connections.items.value" :key="c.name" class="ritem">
        <h4>
          <span>{{ c.name }}</span>
          <span :class="statusPillClass(c.status)">{{ connectionStatusLabel(c.status) }}</span>
        </h4>
        <p v-if="c.detail">{{ formatDetail(c.detail) }}</p>
      </div>
    </section>
  </aside>
</template>
