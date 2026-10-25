<script setup lang="ts">
// 审批：待审批列表 / 批准 / 拒绝（拒绝要理由，与旧版 prompt 等价）。
// 加载走统一三态：失败时只显示错误与重试，绝不显示「暂无待审批事项」之外的空态误导
// （四维评审 FE-5 的硬性验收）；风险与状态只经 labels.ts 人话映射渲染。
import { onMounted } from "vue";
import { api } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import { approvalStatusLabel, riskLabel } from "../labels";
import { useAppStore } from "../stores/app";
import type { Approval } from "../types";

const store = useAppStore();
const approvals = useAsyncList<Approval>(() => api<Approval[]>("/api/approvals"));
const action = useActionState();

async function loadApprovals(): Promise<void> {
  await approvals.load();
  void store.refreshBadge();
}

async function decide(a: Approval, ok: boolean): Promise<void> {
  const reason = ok ? "" : prompt("请输入拒绝理由（可选）") || "";
  await action.runAction(`decide-${a.id}`, async () => {
    await api(`/api/approvals/${a.id}/decide`, {
      method: "POST",
      body: JSON.stringify({ approved: ok, reason }),
    });
    await loadApprovals();
  });
}

onMounted(loadApprovals);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>审批</h2>
      <span class="muted">涉及资金或重要操作须先经审批</span>
    </div>
    <p v-if="approvals.loading.value" class="muted">正在加载审批事项…</p>
    <p v-else-if="approvals.error.value" class="err">
      审批事项加载失败：{{ approvals.error.value }} <button @click="approvals.retry">重试</button>
    </p>
    <p v-else-if="!approvals.items.value.length" class="muted">暂无待审批事项。</p>
    <div v-else class="cards">
      <div v-for="a in approvals.items.value" :key="a.id" class="card">
        <h3>{{ a.title }}</h3>
        <p>{{ a.detail }}</p>
        <p>
          <span v-if="a.amount_usd" class="tag risk">金额 ${{ a.amount_usd }}</span>
          <span class="tag">{{ riskLabel(a.risk_level) }}</span>
          <span class="tag">{{ approvalStatusLabel(a.status) }}</span>
        </p>
        <div v-if="a.status === 'pending'" class="row">
          <button :disabled="action.busy.value !== null" @click="decide(a, true)">批准</button>
          <button :disabled="action.busy.value !== null" @click="decide(a, false)">拒绝</button>
        </div>
      </div>
    </div>
    <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
  </section>
</template>
