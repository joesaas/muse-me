import type {
  Approval,
  Chat,
  Message,
  RunEventRecord,
  RunRecord,
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
