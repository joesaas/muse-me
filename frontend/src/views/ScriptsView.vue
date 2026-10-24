<script setup lang="ts">
// 我的脚本：试运行 / 运行 / 设为定时任务。
// 评审 P2 修复：试运行结果渲染成步骤清单（人话），不再输出原始 JSON。
import { onMounted, ref } from "vue";
import { api } from "../api";
import { useAppStore } from "../stores/app";
import type { Script, ScriptRunResult, ScriptRunStep } from "../types";

const store = useAppStore();
const list = ref<Script[]>([]);
const trialResults = ref<Record<string, ScriptRunResult>>({});
const runNotes = ref<Record<string, string>>({});

// 工具名 → 人话动作名（未收录的回退为工具名本身）。
const TOOL_LABELS: Record<string, string> = {
  "meme.scan": "查流动性与风险",
  "market.quote": "询价",
  "dex.quote": "询价",
  "dex.sim_swap": "模拟买入",
  "aave.rates": "查 Aave 利率",
  "aave.sim_supply": "模拟存入 Aave",
  "news.search": "搜新闻",
  "web.fetch": "抓取网页",
  "notify.send": "发通知",
};

// 每步结果里挑一条人话摘要：优先 summary，其次常见数值字段。
function stepSummary(step: ScriptRunStep): string {
  const r = step.result || {};
  if (typeof r.summary === "string" && r.summary) return r.summary;
  const parts: string[] = [];
  if (typeof r.token === "string") parts.push(`标的 ${r.token}`);
  if (typeof r.price_usd === "number") parts.push(`价格 $${r.price_usd}`);
  if (typeof r.liquidity_usd === "number") parts.push(`流动性 $${r.liquidity_usd.toLocaleString()}`);
  if (typeof r.risk_level === "string") parts.push(`风险 ${r.risk_level}`);
  if (typeof r.slippage_pct === "number") parts.push(`滑点 ${r.slippage_pct}%`);
  if (typeof r.apy === "number") parts.push(`年化 ${r.apy}%`);
  if (typeof r.amount_usd === "number") parts.push(`金额 $${r.amount_usd}`);
  if (r.simulated) parts.push("模拟数据");
  return parts.join(" · ") || "已完成";
}

function statusLabel(status: string): string {
  if (status === "done") return "试运行完成";
  if (status === "awaiting_approval") return "停在待确认";
  if (status === "failed") return "试运行失败";
  return status;
}

async function loadScripts(): Promise<void> {
  list.value = await api<Script[]>("/api/scripts");
}

async function trial(s: Script): Promise<void> {
  const r = await api<ScriptRunResult>(`/api/scripts/${s.id}/trial`, {
    method: "POST",
    body: "{}",
  });
  trialResults.value = { ...trialResults.value, [s.id]: r };
}

async function run(s: Script): Promise<void> {
  await api(`/api/scripts/${s.id}/run`, { method: "POST", body: "{}" });
  runNotes.value = {
    ...runNotes.value,
    [s.id]: "已开始运行，去「执行记录」可回放；如需拍板会出现在「待我确认」。",
  };
  void store.refreshBadge();
}

async function bind(s: Script): Promise<void> {
  const minutes = prompt("每隔多少分钟自动运行一次？", "60");
  if (!minutes) return;
  await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      script_id: s.id,
      trigger: { type: "time", every_minutes: Number(minutes) },
      name: "定时运行脚本",
    }),
  });
  alert("已设为定时任务，去「定时任务」里能看到");
}

onMounted(loadScripts);
</script>

<template>
  <section class="view">
    <div class="bar">
      <h2>我的脚本</h2>
      <span class="muted">脚本是和助手在聊天里一起做出来的个性化程序</span>
    </div>
    <div class="cards">
      <div v-for="s in list" :key="s.id" class="card">
        <h3>{{ s.name }}</h3>
        <p class="muted">
          版本 v{{ s.version }} · 参数：{{ (s.params || []).map((p) => p.label).join("、") || "无" }}
        </p>
        <p>{{ s.description }}</p>
        <div class="row">
          <button @click="trial(s)">试运行</button>
          <button @click="run(s)">运行</button>
          <button @click="bind(s)">设为定时任务</button>
        </div>

        <div v-if="trialResults[s.id]" class="trial-out">
          <p>
            <strong>{{ statusLabel(trialResults[s.id]!.status) }}</strong>
            <span class="muted"> · 本次花费 ${{ trialResults[s.id]!.spent_usd }}</span>
          </p>
          <ol class="step-list">
            <li v-for="st in trialResults[s.id]!.steps" :key="st.step">
              <span class="tag">{{ TOOL_LABELS[st.tool] || st.tool }}</span>
              {{ stepSummary(st) }}
            </li>
          </ol>
          <p v-if="trialResults[s.id]!.error" class="err">{{ trialResults[s.id]!.error }}</p>
          <p v-if="!trialResults[s.id]!.steps.length" class="muted">这一步还没有执行到任何步骤。</p>
        </div>
        <p v-if="runNotes[s.id]">{{ runNotes[s.id] }}</p>
      </div>
      <p v-if="!list.length" class="muted">
        还没有脚本。去聊天里说一件想做的事，助手会帮你做成脚本。
      </p>
    </div>
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
