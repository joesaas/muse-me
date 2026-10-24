// 聊天展示项合并纯逻辑（四维评审 FE-3，遗留①根因）。
// 落库消息是正本；进行中运行的本地增量（工具提示行、系统提示行、
// 流式气泡）与落库消息合并渲染，而不是整表覆盖。
// 终态到达后 live 被清空，下一次重拉即为纯落库视图。
import { normalizeMessageRole } from "./api";
import type { Message } from "./types";

export type DisplayItem =
  | { kind: "msg"; role: string; content: string }
  | { kind: "tool"; text: string };

export interface LiveRunView {
  bubble: DisplayItem | null;
  extras: DisplayItem[];
}

/** 落库消息 + 本地增量合并：增量追加在落库消息之后，顺序稳定。 */
export function mergeDisplayItems(
  dbMessages: Message[],
  live: LiveRunView | null,
): DisplayItem[] {
  const base: DisplayItem[] = dbMessages.map((m) => ({
    kind: "msg" as const,
    role: normalizeMessageRole(m.role),
    content: m.content,
  }));
  if (!live) return base;
  const out = [...base, ...live.extras];
  if (live.bubble) out.push(live.bubble);
  return out;
}

export function isTerminalEventType(type: string): boolean {
  return type === "run_done" || type === "run_failed" || type === "run_cancelled";
}
