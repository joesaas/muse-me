// muse-me 前端（TypeScript）：无框架单页应用。
// 界面只用小白名；与后端的契约类型在 types.ts，字段改动由 tsc 拦截。
import type {
  Approval, Chat, Connection, FeedItem, FileItem, Job, MemoryItem,
  Message, PromptDoc, Run, Script, Trigger,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => {
  const el = document.querySelector<T>(s);
  if (!el) throw new Error(`missing element ${s}`);
  return el;
};

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error((await r.text()) || String(r.status));
  return (r.status === 204 ? null : await r.json()) as T;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

let currentChat: string | null = null;
let currentRun: string | null = null;
let es: EventSource | null = null;

function showLogin(): void { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
function showApp(): void { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }

async function boot(): Promise<void> {
  try { await api<Chat[]>("/api/chats"); showApp(); init(); }
  catch { showLogin(); }
}

$("#login-btn").addEventListener("click", async () => {
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $<HTMLInputElement>("#login-pw").value }) });
    showApp(); init();
  } catch { $("#login-err").textContent = "口令不对，再试试"; }
});

function init(): void { switchView("chat"); void loadChats(); void refreshBadge(); }

// ---------- 视图切换 ----------
document.querySelectorAll<HTMLElement>("#menu button, .more button").forEach((b) => {
  b.addEventListener("click", () => { if (b.dataset.view) switchView(b.dataset.view); });
});
function switchView(v: string): void {
  document.querySelectorAll(".view").forEach((s) => s.classList.add("hidden"));
  $("#view-" + v).classList.remove("hidden");
  document.querySelectorAll<HTMLElement>("#menu button, .more button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === v));
  const loaders: Record<string, () => Promise<void>> = {
    feed: loadFeed, scripts: loadScripts, jobs: loadJobs, approvals: loadApprovals,
    files: loadFiles, runs: loadRuns, memories: loadMemories, settings: loadConnections,
  };
  void loaders[v]?.();
}

// ---------- 聊天 ----------
async function loadChats(): Promise<void> {
  const chats = await api<Chat[]>("/api/chats");
  $("#chats").innerHTML = chats.map((c) =>
    `<li data-id="${c.id}" class="${c.id === currentChat ? "active" : ""}">${esc(c.title)}<small>${c.kind === "side" ? "新话题" : "主聊"} · ${esc(c.updated_at)}</small></li>`).join("");
  document.querySelectorAll<HTMLElement>("#chats li").forEach((li) =>
    li.addEventListener("click", () => { if (li.dataset.id) void openChat(li.dataset.id); }));
  if (!currentChat && chats[0]) await openChat(chats[0].id);
}
async function openChat(id: string): Promise<void> {
  currentChat = id;
  const msgs = await api<Message[]>(`/api/chats/${id}/messages`);
  $("#messages").innerHTML = msgs.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("");
  scrollMsgs(); void loadChats();
}
$("#new-chat").addEventListener("click", async () => {
  const c = await api<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ kind: "side", title: "新话题" }) });
  currentChat = c.id; await openChat(c.id);
});
function addMsg(role: string, text: string): HTMLDivElement {
  const d = document.createElement("div"); d.className = "msg " + role; d.textContent = text;
  $("#messages").appendChild(d); scrollMsgs(); return d;
}
function addTool(text: string): void {
  const d = document.createElement("div"); d.className = "tool"; d.textContent = text;
  $("#messages").appendChild(d); scrollMsgs();
}
function scrollMsgs(): void { const m = $("#messages"); m.scrollTop = m.scrollHeight; }

$("#send").addEventListener("click", async () => {
  const input = $<HTMLTextAreaElement>("#input");
  const text = input.value.trim(); if (!text) return;
  if (!currentChat) {
    const c = await api<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ kind: "main", title: "主聊" }) });
    currentChat = c.id;
  }
  input.value = ""; addMsg("user", text);
  const { run_id } = await api<{ run_id: string }>(`/api/chats/${currentChat}/send`, { method: "POST", body: JSON.stringify({ text }) });
  currentRun = run_id; streamRun(run_id, addMsg("assistant", ""));
});
$("#stop").addEventListener("click", async () => {
  if (currentRun) await api(`/api/runs/${currentRun}/cancel`, { method: "POST" });
});

function streamRun(runId: string, bubble: HTMLDivElement): void {
  es?.close();
  es = new EventSource(`/api/events?run_id=${runId}`);
  es.onmessage = (ev: MessageEvent<string>) => {
    const e = JSON.parse(ev.data) as { type: string; text?: string; tool?: string; summary?: string };
    if (e.type === "assistant_delta" && e.text) { bubble.textContent += e.text; scrollMsgs(); }
    if (e.type === "tool_called") addTool(`用了工具：${e.tool ?? ""} ${e.summary ?? ""}`);
    if (e.type === "approval_required") { addMsg("sys", "有一件事停在「待我确认」里等你拍板"); void refreshBadge(); }
    if (["run_done", "run_failed", "run_cancelled"].includes(e.type)) { es?.close(); void loadChats(); }
  };
  es.onerror = () => es?.close();
}

// ---------- 今日精选 ----------
async function loadFeed(): Promise<void> {
  const items = await api<FeedItem[]>("/api/feed");
  $("#feed-items").innerHTML = items.map((f) => `
    <div class="card"><h3>${esc(f.title)}</h3><p>${esc(f.summary)}</p>
    <p>${(f.entities || []).map((e) => `<span class="tag">${esc(e.label || e.value)}</span>`).join("")}</p>
    <p class="muted">${esc(f.source)} · ${esc(f.published_at)}</p>
    <div class="row">
      <button data-act="ask" data-id="${f.id}">追问</button>
      <button data-act="build" data-id="${f.id}">基于此构建脚本</button>
    </div></div>`).join("");
}
$("#feed-items").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b?.dataset.id) return;
  const kind = b.dataset.act === "build"
    ? { kind: "side", feed_item_id: b.dataset.id, title: "构建脚本", scene: "script_build" }
    : { kind: "side", feed_item_id: b.dataset.id, title: "精选追问" };
  const c = await api<Chat>("/api/chats", { method: "POST", body: JSON.stringify(kind) });
  currentChat = c.id; switchView("chat"); await openChat(c.id);
  if (b.dataset.act === "build") addMsg("sys", "已把这条精选带进来。直接说你想做什么，例如：买这个 meme，100 美元，先查流动性。");
});
$("#feed-refresh").addEventListener("click", async () => { await api("/api/feed/refresh", { method: "POST" }); await loadFeed(); });
$("#feed-prompt-btn").addEventListener("click", async () => {
  const p = await api<PromptDoc>("/api/prompts/feed");
  $<HTMLTextAreaElement>("#feed-prompt").value = p.content;
  $("#feed-prompt-ver").textContent = "当前版本 v" + p.version;
  $("#feed-prompt-box").classList.toggle("hidden");
});
$("#feed-prompt-rollback").addEventListener("click", async () => {
  const versions = await api<PromptDoc[]>("/api/prompts/feed/versions");
  const prev = versions[versions.length - 2];
  if (!prev) { alert("还没有上一版"); return; }
  const p = await api<PromptDoc>("/api/prompts/feed/rollback", { method: "POST", body: JSON.stringify({ version: prev.version }) });
  $<HTMLTextAreaElement>("#feed-prompt").value = p.content;
  $("#feed-prompt-ver").textContent = "已回到旧内容，存为 v" + p.version; await loadFeed();
});
$("#feed-prompt-save").addEventListener("click", async () => {
  const p = await api<PromptDoc>("/api/prompts/feed", { method: "PUT", body: JSON.stringify({ content: $<HTMLTextAreaElement>("#feed-prompt").value }) });
  $("#feed-prompt-ver").textContent = "已保存为 v" + p.version; await loadFeed();
});

// ---------- 我的脚本 ----------
async function loadScripts(): Promise<void> {
  const list = await api<Script[]>("/api/scripts");
  $("#script-items").innerHTML = list.map((s) => `
    <div class="card"><h3>${esc(s.name)}</h3>
    <p class="muted">版本 v${s.version} · 参数：${(s.params || []).map((p) => esc(p.label)).join("、") || "无"}</p>
    <p>${esc(s.description)}</p>
    <div class="row">
      <button data-act="trial" data-id="${s.id}">试运行</button>
      <button data-act="run" data-id="${s.id}">运行</button>
      <button data-act="bind" data-id="${s.id}">设为定时任务</button>
    </div><div id="script-out-${s.id}"></div></div>`).join("")
    || "<p class='muted'>还没有脚本。去聊天里说一件想做的事，助手会帮你做成脚本。</p>";
}
$("#script-items").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b?.dataset.id) return;
  const id = b.dataset.id;
  if (b.dataset.act === "trial") {
    const r = await api<unknown>(`/api/scripts/${id}/trial`, { method: "POST", body: "{}" });
    $(`#script-out-${id}`).innerHTML = `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`;
  }
  if (b.dataset.act === "run") {
    await api(`/api/scripts/${id}/run`, { method: "POST", body: "{}" });
    $(`#script-out-${id}`).innerHTML = "<p>已开始运行，去「执行记录」可回放；如需拍板会出现在「待我确认」。</p>";
    void refreshBadge();
  }
  if (b.dataset.act === "bind") {
    const minutes = prompt("每隔多少分钟自动运行一次？", "60"); if (!minutes) return;
    await api("/api/jobs", { method: "POST", body: JSON.stringify({ script_id: id, trigger: { type: "time", every_minutes: Number(minutes) }, name: "定时运行脚本" }) });
    alert("已设为定时任务，去「定时任务」里能看到");
  }
});

// ---------- 定时任务 ----------
function describeTrigger(t: Trigger | undefined): string {
  if (!t) return "-";
  if (t.type === "time") return t.cron_daily ? `每天 ${t.cron_daily}` : `每 ${t.every_minutes ?? "?"} 分钟`;
  if (t.type === "event") return `精选出现「${t.keyword}」时`;
  return `${t.metric} ${t.op} ${t.threshold} 时`;
}
async function loadJobs(): Promise<void> {
  const list = await api<Job[]>("/api/jobs");
  $("#job-items").innerHTML = list.map((j) => `
    <div class="card"><h3>${esc(j.name)}</h3>
    <p>触发：${esc(describeTrigger(j.trigger))} · 状态：${j.enabled ? "进行中" : "已暂停"}</p>
    <p class="muted">下次运行：${esc(j.next_run_at ?? "-")} · 最近结果：${esc(j.last_status ?? "还没跑过")}</p>
    <div class="row"><button data-act="toggle" data-id="${j.id}">${j.enabled ? "暂停" : "恢复"}</button></div></div>`).join("")
    || "<p class='muted'>还没有定时任务。在「我的脚本」里把脚本设为定时任务即可。</p>";
}
$("#job-items").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b?.dataset.id) return;
  await api(`/api/jobs/${b.dataset.id}/toggle`, { method: "POST" }); await loadJobs();
});

// ---------- 待我确认 ----------
async function refreshBadge(): Promise<void> {
  try {
    const list = await api<Approval[]>("/api/approvals");
    const n = list.filter((a) => a.status === "pending").length;
    const b = $("#appr-badge"); b.textContent = String(n); b.classList.toggle("hidden", !n);
  } catch { /* 未登录时静默 */ }
}
async function loadApprovals(): Promise<void> {
  const list = await api<Approval[]>("/api/approvals");
  $("#approval-items").innerHTML = list.map((a) => `
    <div class="card"><h3>${esc(a.title)}</h3><p>${esc(a.detail)}</p>
    <p>${a.amount_usd ? `<span class="tag risk">金额 $${esc(a.amount_usd)}</span>` : ""}<span class="tag">${esc(a.risk_level)}</span>
    <span class="tag">${a.status === "pending" ? "等你拍板" : a.status === "approved" ? "已批准" : "已拒绝"}</span></p>
    ${a.status === "pending" ? `<div class="row"><button data-act="ok" data-id="${a.id}">批准</button><button data-act="no" data-id="${a.id}">拒绝</button></div>` : ""}
    </div>`).join("") || "<p class='muted'>现在没有需要你确认的事。</p>";
  void refreshBadge();
}
$("#approval-items").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b?.dataset.id) return;
  const ok = b.dataset.act === "ok";
  const reason = ok ? "" : (prompt("拒绝理由（可空）") || "");
  await api(`/api/approvals/${b.dataset.id}/decide`, { method: "POST", body: JSON.stringify({ approved: ok, reason }) });
  await loadApprovals();
});

// ---------- 我的文件 / 执行记录 / 它记得的事 / 账号与连接 ----------
async function loadFiles(): Promise<void> {
  const list = await api<FileItem[]>("/api/files");
  $("#file-items").innerHTML = list.map((f) => `<div class="card"><h3>${esc(f.name)}</h3><p class="muted">${esc(f.kind)} · ${esc(f.created_at)}</p>
    <div class="row"><a href="/api/files/${f.id}/download"><button>下载</button></a></div></div>`).join("")
    || "<p class='muted'>还没有文件。脚本和评估报告会存到这里。</p>";
}
async function loadRuns(): Promise<void> {
  const list = await api<Run[]>("/api/runs");
  $("#run-items").innerHTML = list.map((r) => `<div class="card"><h3>${esc(r.title || r.kind)}</h3>
    <p>状态：${esc(r.status)} · 花费：$${esc(r.cost_usd ?? 0)}</p><p class="muted">${esc(r.created_at)}</p>
    <div class="row"><button data-act="show" data-id="${r.id}">回放</button></div></div>`).join("");
}
$("#run-items").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b?.dataset.id) return;
  const r = await api<Run>(`/api/runs/${b.dataset.id}`);
  const box = $("#run-detail"); box.classList.remove("hidden");
  box.innerHTML = `<h3>回放：${esc(r.title)}</h3><pre>${esc((r.events || []).map((e) => `${e.ts ?? ""} ${e.type} ${e.summary ?? ""}`).join("\n"))}</pre>`;
});
$("#runs-refresh").addEventListener("click", () => void loadRuns());

async function loadMemories(): Promise<void> {
  const list = await api<MemoryItem[]>("/api/memories");
  $("#memory-items").innerHTML = list.map((m) => `<div class="card"><p>${esc(m.content)}</p>
    <p><span class="tag">${m.level === "fact" ? "事实" : "推测"}</span><span class="tag">${m.status === "active" ? "已生效" : "等你批准"}</span></p>
    <div class="row">${m.status !== "active" ? `<button data-act="ok" data-id="${m.id}">批准记住</button><button data-act="no" data-id="${m.id}">不要记</button>` : ""}
    <button data-act="del" data-id="${m.id}">删掉</button></div></div>`).join("")
    || "<p class='muted'>它还没有记住任何事。</p>";
}
$("#memory-items").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b?.dataset.id) return;
  if (b.dataset.act === "del") await api(`/api/memories/${b.dataset.id}`, { method: "DELETE" });
  else await api(`/api/memories/${b.dataset.id}/decide`, { method: "POST", body: JSON.stringify({ approved: b.dataset.act === "ok" }) });
  await loadMemories();
});

async function loadConnections(): Promise<void> {
  const list = await api<Connection[]>("/api/settings/connections");
  $("#connection-items").innerHTML = list.map((c) => `<div class="card"><h3>${esc(c.name)}</h3><p>${esc(c.status)}</p><p class="muted">${esc(c.detail)}</p></div>`).join("");
}

void boot();
