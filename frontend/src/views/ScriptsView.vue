<script setup lang="ts">
// 插件：试运行 / 运行 / 设为定时任务。
// 试运行结果渲染成步骤清单（人话），不再输出原始 JSON。
// 三态 + 动作容错（四维评审 FE-5/FE-9）：列表加载走 useAsyncList，
// trial/run/bind 走 useActionState（进行中禁用、失败提示）；
// bind 分钟数前端先校验为正整数，非法不发请求；工具名与风险只经 labels.ts 渲染。
import { onMounted, ref } from "vue";
import { api } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import { riskLabel, scriptRunStatusLabel, toolLabel } from "../labels";
import { useAppStore } from "../stores/app";
import type { Script, ScriptRunResult, ScriptRunStep } from "../types";

const store = useAppStore();
const scripts = useAsyncList<Script>(() => api<Script[]>("/api/scripts"));
const action = useActionState();
const trialResults = ref<Record<string, ScriptRunResult>>({});
const runNotes = ref<Record<string, string>>({});

// 每步结果里挑一条人话摘要：优先 summary，其次常见数值字段。
function stepSummary(step: ScriptRunStep): string {
  const r = step.result || {};
  if (typeof r.summary === "string" && r.summary) return r.summary;
  const parts: string[] = [];
  if (typeof r.token === "string") parts.push(`标的 ${r.token}`);
  if (typeof r.price_usd === "number") parts.push(`价格 $${r.price_usd}`);
  if (typeof r.liquidity_usd === "number") parts.push(`流动性 $${r.liquidity_usd.toLocaleString()}`);
  if (typeof r.risk_level === "string") parts.push(`风险 ${riskLabel(r.risk_level)}`);
  if (typeof r.slippage_pct === "number") parts.push(`滑点 ${r.slippage_pct}%`);
  if (typeof r.apy === "number") parts.push(`年化 ${r.apy}%`);
  if (typeof r.amount_usd === "number") parts.push(`金额 $${r.amount_usd}`);
  if (r.simulated) parts.push("模拟数据");
  return parts.join(" · ") || "已完成";
}

async function trial(s: Script): Promise<void> {
  await action.runAction(`trial-${s.id}`, async () => {
    const r = await api<ScriptRunResult>(`/api/scripts/${s.id}/trial`, {
      method: "POST",
      body: "{}",
    });
    trialResults.value = { ...trialResults.value, [s.id]: r };
  });
}

async function run(s: Script): Promise<void> {
  await action.runAction(`run-${s.id}`, async () => {
    await api(`/api/scripts/${s.id}/run`, { method: "POST", body: "{}" });
    runNotes.value = {
      ...runNotes.value,
      [s.id]: "已开始运行，可在「运行历史」中回放；如需审批，将出现在「审批」。",
    };
    void store.refreshBadge();
  });
}

async function bind(s: Script): Promise<void> {
  const minutes = prompt("请输入运行间隔（分钟）", "60");
  if (minutes === null) return;
  // 前端先校验为正整数：非法输入不发请求，直接给提示（四维评审 FE-9）。
  if (!/^\d+$/.test(minutes.trim()) || Number(minutes) <= 0) {
    action.error.value = "请输入正整数分钟数，例如 60";
    return;
  }
  await action.runAction(`bind-${s.id}`, async () => {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        script_id: s.id,
        trigger: { type: "time", every_minutes: Number(minutes) },
        name: "定时运行脚本",
      }),
    });
    alert("已设为定时任务，可在「定时任务」中查看");
  });
}

onMounted(scripts.load);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>插件</h2>
      <span class="muted">在对话中与助手共创的个性化程序</span>
    </div>
    <p v-if="scripts.loading.value" class="muted">正在加载脚本…</p>
    <p v-else-if="scripts.error.value" class="err">
      脚本加载失败：{{ scripts.error.value }} <button @click="scripts.retry">重试</button>
    </p>
    <p v-else-if="!scripts.items.value.length" class="muted">
      暂无插件。在「聊天」中描述需求，助手将为你创建插件。
    </p>
    <div v-else class="cards">
      <div v-for="s in scripts.items.value" :key="s.id" class="card">
        <h3>{{ s.name }}</h3>
        <p class="muted">
          版本 v{{ s.version }} · 参数：{{ (s.params || []).map((p) => p.label).join("、") || "无" }}
        </p>
        <p>{{ s.description }}</p>
        <div class="row">
          <button :disabled="action.busy.value !== null" @click="trial(s)">试运行</button>
          <button :disabled="action.busy.value !== null" @click="run(s)">运行</button>
          <button :disabled="action.busy.value !== null" @click="bind(s)">设为定时任务</button>
        </div>

        <div v-if="trialResults[s.id]" class="trial-out">
          <p>
            <strong>{{ scriptRunStatusLabel(trialResults[s.id]!.status) }}</strong>
            <span class="muted"> · 本次花费 ${{ trialResults[s.id]!.spent_usd }}</span>
          </p>
          <ol class="step-list">
            <li v-for="st in trialResults[s.id]!.steps" :key="st.step">
              <span class="tag">{{ toolLabel(st.tool) }}</span>
              {{ stepSummary(st) }}
            </li>
          </ol>
          <p v-if="trialResults[s.id]!.error" class="err">{{ trialResults[s.id]!.error }}</p>
          <p v-if="!trialResults[s.id]!.steps.length" class="muted">暂无执行步骤。</p>
        </div>
        <p v-if="runNotes[s.id]">{{ runNotes[s.id] }}</p>
      </div>
    </div>
    <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
  </section>
</template>

<style scoped>
.trial-out {
  margin-top: 10px;
  border-top: 1px solid #e8ebf1;
  padding-top: 8px;
}
.step-list {
  margin: 6px 0;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.7;
}
</style>
