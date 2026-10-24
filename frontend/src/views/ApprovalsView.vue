<script setup lang="ts">
// 待我确认：待审批列表 / 批准 / 拒绝（拒绝要理由，与旧版 prompt 等价）。
import { onMounted, ref } from "vue";
import { api } from "../api";
import { useAppStore } from "../stores/app";
import type { Approval } from "../types";

const store = useAppStore();
const list = ref<Approval[]>([]);

function statusLabel(a: Approval): string {
  return a.status === "pending" ? "等你拍板" : a.status === "approved" ? "已批准" : "已拒绝";
}

async function loadApprovals(): Promise<void> {
  list.value = await api<Approval[]>("/api/approvals");
  void store.refreshBadge();
}

async function decide(a: Approval, ok: boolean): Promise<void> {
  const reason = ok ? "" : prompt("拒绝理由（可空）") || "";
  await api(`/api/approvals/${a.id}/decide`, {
    method: "POST",
    body: JSON.stringify({ approved: ok, reason }),
  });
  await loadApprovals();
}

onMounted(loadApprovals);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>待我确认</h2>
      <span class="muted">花钱或重要操作都会先停在这里等你拍板</span>
    </div>
    <div class="cards">
      <div v-for="a in list" :key="a.id" class="card">
        <h3>{{ a.title }}</h3>
        <p>{{ a.detail }}</p>
        <p>
          <span v-if="a.amount_usd" class="tag risk">金额 ${{ a.amount_usd }}</span>
          <span class="tag">{{ a.risk_level }}</span>
          <span class="tag">{{ statusLabel(a) }}</span>
        </p>
        <div v-if="a.status === 'pending'" class="row">
          <button @click="decide(a, true)">批准</button>
          <button @click="decide(a, false)">拒绝</button>
        </div>
      </div>
      <p v-if="!list.length" class="muted">现在没有需要你确认的事。</p>
    </div>
  </section>
</template>
