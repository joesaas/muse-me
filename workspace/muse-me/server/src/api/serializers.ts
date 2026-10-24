import type {
  Approval,
  Chat,
  FeedItemRecord,
  FileRecord,
  JobRecord,
  MemoryRecord,
  Message,
  RunEventRecord,
  RunRecord,
  ScriptRecord,
} from "../domain/types.js";

/**
 * API 序列化层：领域记录 -> frontend/src/types.ts 契约 JSON 的唯一收口点
 * （与 Python api.py 的 *_json 同口径：字段名、拼装文案在此对齐）。
 */

export function chatJson(chat: Chat): Record<string, unknown> {
  return {
    id: chat.id,
    title: chat.title,
    kind: chat.kind,
    feed_item_id: chat.feedItemId,
    updated_at: chat.updatedAt,
  };
}

export function messageJson(message: Message): Record<string, unknown> {
  const role = message.role === "system" || message.role === "tool" ? "sys" : message.role;
  return {
    id: message.id,
    chat_id: message.chatId,
    role,
    content: message.content,
    created_at: message.createdAt,
  };
}

/** 事件摘要（与 Python event_summary 同口径）。 */
export function eventSummary(event: RunEventRecord): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "tool_called":
      return `${String(p.tool ?? "")} ${JSON.stringify(p.args ?? {})}`;
    case "step_done":
      return `${String(p.tool ?? "")} 完成`;
    case "approval_required":
      return `等待确认：${String(p.tool ?? "")}`;
    case "assistant_delta":
      return String(p.text ?? "");
    case "run_failed":
      return String(p.error ?? p.reason ?? "");
    case "plan_created":
      return `计划：${String(p.script_name ?? p.goal ?? "")}`;
    default:
      return String(p.label ?? "");
  }
}

export function eventJson(event: RunEventRecord): Record<string, unknown> {
  return {
    seq: event.seq,
    type: event.type,
    ts: event.createdAt,
    tool: (event.payload.tool as string | undefined) ?? null,
    summary: eventSummary(event),
    text: (event.payload.text as string | undefined) ?? null,
  };
}

export function approvalJson(approval: Approval): Record<string, unknown> {
  return {
    id: approval.id,
    title: `确认执行：${approval.action}`,
    detail:
      `运行中的敏感步骤（第 ${approval.stepIndex + 1} 步），` +
      "批准后才继续；拒绝将停止这次任务。",
    amount_usd: approval.amountUsd,
    risk_level: approval.risk,
    status: approval.status,
  };
}

export function runJson(
  run: RunRecord,
  title: string,
  events?: RunEventRecord[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: run.id,
    title,
    kind: run.source,
    status: run.status,
    cost_usd: run.costUsd,
    created_at: run.createdAt,
  };
  if (events) out.events = events.map(eventJson);
  return out;
}

/** 精选条目（同 Python feed_json：entities dict 展开为 {label, value, kind} 数组）。 */
export function feedJson(item: FeedItemRecord): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    entities: Object.entries(item.entities ?? {}).map(([k, v]) => ({
      label: String(v),
      value: String(v),
      kind: String(k),
    })),
    source: item.source,
    published_at: item.publishedAt,
  };
}

/** 脚本（同 Python script_json：params 取 doc.params）。 */
export function scriptJson(script: ScriptRecord): Record<string, unknown> {
  const params = Array.isArray(script.doc?.params) ? script.doc.params : [];
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    version: script.currentVersion,
    params,
  };
}

/** 定时任务（同 Python _job_json：trigger 合併 type 与 spec，last_status 由服务层查）。 */
export function jobJson(job: JobRecord, lastStatus: string): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    script_id: job.scriptId,
    trigger: { type: job.triggerType, ...(job.triggerSpec ?? {}) },
    enabled: job.enabled,
    next_run_at: job.nextFireAt,
    last_status: lastStatus,
  };
}

export function memoryJson(item: MemoryRecord): Record<string, unknown> {
  return {
    id: item.id,
    content: item.content,
    level: item.level,
    status: item.status,
  };
}

export function fileJson(row: FileRecord): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    created_at: row.createdAt,
  };
}
