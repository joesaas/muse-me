// 与 Python API 的契约类型：字段名与后端 JSON 一一对应（细节设计 §3）。
// 后端改字段必须同步改这里，vue-tsc 会把不一致拦在编译期。

export interface Chat {
  id: string;
  title: string;
  kind: "main" | "side";
  scene?: string;
  feed_item_id?: string | null;
  updated_at?: string;
}

export interface Message {
  id: string;
  chat_id: string;
  // 与两后端落库一致：system（旧前端曾用 sys，已归一，见 api.normalizeMessageRole）。
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
}

export interface RunEvent {
  // seq：server SSE 的事件序号（帧 id 与 data.seq 一致）；无序号的旧帧为 undefined。
  seq?: number;
  type: string;
  text?: string;
  tool?: string;
  summary?: string;
  ts?: string;
}

export interface FeedEntity {
  label?: string;
  value: string;
  kind?: string;
}

export interface FeedItem {
  id: string;
  title: string;
  summary: string;
  entities: FeedEntity[];
  source?: string;
  published_at?: string;
}

export interface PromptDoc {
  content: string;
  version: number;
}

export interface ScriptParam {
  key: string;
  label: string;
  type: "string" | "number";
  default?: string | number;
}

export interface Script {
  id: string;
  name: string;
  description?: string;
  version: number;
  params: ScriptParam[];
}

// 脚本试运行/正式运行的返回：字段按 scripts_engine.run_script 的 finish() 构造
// （run_id/status/facts/steps/spent_usd，外加 awaiting 时的 approval_id、失败时的 error）。
export interface ScriptRunStep {
  step: number;
  tool: string;
  result: Record<string, unknown>;
}

export interface ScriptRunResult {
  run_id: string;
  status: "done" | "awaiting_approval" | "failed" | string;
  facts: Record<string, unknown>;
  steps: ScriptRunStep[];
  spent_usd: number;
  approval_id?: string;
  error?: string;
}

export type Trigger =
  | { type: "time"; every_minutes?: number; cron_daily?: string }
  | { type: "event"; keyword: string }
  | { type: "condition"; metric: string; op: string; threshold: number };

export interface Job {
  id: string;
  name: string;
  script_id: string;
  trigger: Trigger;
  enabled: boolean;
  next_run_at?: string;
  last_status?: string;
}

export interface Approval {
  id: string;
  title: string;
  detail?: string;
  amount_usd?: number;
  risk_level?: string;
  status: "pending" | "approved" | "denied";
}

export interface FileItem {
  id: string;
  name: string;
  kind: string;
  created_at?: string;
}

export interface Run {
  id: string;
  title?: string;
  kind: string;
  status: string;
  cost_usd?: number;
  created_at?: string;
  events?: RunEvent[];
}

export interface MemoryItem {
  id: string;
  content: string;
  level: "fact" | "inference" | "never";
  // 评审修复：decide 接口可返回被拒绝的记忆，联合须含 "rejected"。
  status: "active" | "pending" | "rejected";
}

export interface Connection {
  name: string;
  status: string;
  detail?: string;
}
