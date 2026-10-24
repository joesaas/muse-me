import { randomUUID } from "node:crypto";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { AgentCoreConfig } from "../../config.js";
import { RuntimeNotConfigured, ValidationFailed } from "../../domain/errors.js";
import type { InvokeContext, RunStore, RuntimePort } from "../../domain/ports.js";
import type { RunEventDraft, RunEventRecord, SessionInfo } from "../../domain/types.js";
import { pollStoreEvents } from "./store-event-stream.js";

export const AGENTCORE_CONFIG_HINT =
  "配置 AgentCore 需：1) 环境变量 AWS_REGION（或 AGENTCORE_REGION）；" +
  "2) 环境变量 AGENTCORE_RUNTIME_ARN，即已在 Bedrock AgentCore 部署的 Runtime ARN。" +
  "未配置时本实现 health 报告 not_configured、invoke 抛 RuntimeNotConfigured，不伪装可用。";

/** AgentCore 的 runtimeSessionId 规则：至少 33 个字符。 */
const MIN_SESSION_ID_LENGTH = 33;

/**
 * RuntimePort 的 AgentCore 实现：用官方 SDK 的 InvokeAgentRuntime 调用已部署的
 * Runtime，响应流（SSE 或 JSON）解析为 RunEvent 草稿；给了 RunStore 时同步落库，
 * 使轨迹在控制面可回放（AgentCore 侧 microVM 无持久状态，轨迹正本在控制面）。
 * 注意：本实现按 SDK 契约编写，本期未做真实 AWS 联调（无账号配置），报告中已注明。
 */
export class AgentCoreRuntime implements RuntimePort {
  private client: BedrockAgentCoreClient | undefined;
  private readonly sessions = new Map<string, SessionInfo>();
  /** 应用会话 id -> AgentCore runtimeSessionId（满足 ≥33 字符规则）。 */
  private readonly acSessions = new Map<string, string>();

  constructor(
    private readonly config: AgentCoreConfig,
    private readonly runs?: RunStore,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.region && this.config.runtimeArn);
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new RuntimeNotConfigured("AgentCoreRuntime 未配置。" + AGENTCORE_CONFIG_HINT);
    }
  }

  private getClient(): BedrockAgentCoreClient {
    this.client ??= new BedrockAgentCoreClient({ region: this.config.region });
    return this.client;
  }

  createSession(userId: string, scene = "chat"): SessionInfo {
    this.requireConfigured();
    const session: SessionInfo = {
      id: randomUUID(),
      userId,
      scene,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    // randomUUID 本身 36 字符，前缀后更长，满足 ≥33 规则
    this.acSessions.set(session.id, `museme-${session.id}`);
    return session;
  }

  async *invoke(
    sessionId: string,
    prompt: string,
    ctx: InvokeContext = {},
  ): AsyncIterable<RunEventDraft> {
    this.requireConfigured();
    const runtimeSessionId =
      this.acSessions.get(sessionId) ??
      (sessionId.length >= MIN_SESSION_ID_LENGTH ? sessionId : undefined);
    if (!runtimeSessionId) {
      throw new ValidationFailed(
        `会话 ${sessionId} 无效：AgentCore runtimeSessionId 须至少 ${MIN_SESSION_ID_LENGTH} 字符`,
      );
    }
    const payload = {
      prompt,
      scene: ctx.scene ?? "chat",
      chatId: ctx.chatId ?? null,
      source: ctx.source ?? "chat",
      resume: ctx.resumeRunId
        ? { runId: ctx.resumeRunId, approvedStep: ctx.approvedStep ?? null }
        : null,
    };
    const response = await this.getClient().send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.config.runtimeArn,
        runtimeSessionId,
        contentType: "application/json",
        accept: "text/event-stream",
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    const contentType = response.contentType ?? "";
    if (contentType.includes("text/event-stream")) {
      for await (const draft of this.parseEventStream(response.response)) {
        this.persist(ctx.runId, draft);
        yield draft;
      }
    } else {
      const text = response.response
        ? await response.response.transformToString()
        : "";
      const draft = this.singleResultDraft(text);
      this.persist(ctx.runId, draft);
      yield draft;
    }
  }

  /** 解析 SSE 响应流：每个 data: 行是一条 JSON 事件。 */
  private async *parseEventStream(
    body: unknown,
  ): AsyncIterable<RunEventDraft> {
    if (!body) return;
    const chunks: AsyncIterable<Uint8Array> =
      Symbol.asyncIterator in (body as object)
        ? (body as AsyncIterable<Uint8Array>)
        : (async function* () {
            const bytes = await (
              body as { transformToByteArray: () => Promise<Uint8Array> }
            ).transformToByteArray();
            yield bytes;
          })();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const draft = this.frameToDraft(frame);
        if (draft) yield draft;
        sep = buffer.indexOf("\n\n");
      }
    }
    const tail = this.frameToDraft(buffer);
    if (tail) yield tail;
  }

  private frameToDraft(frame: string): RunEventDraft | undefined {
    const dataLines = frame
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return undefined;
    return this.jsonToDraft(dataLines.join(""));
  }

  private singleResultDraft(text: string): RunEventDraft {
    if (!text) return { type: "result", payload: {} };
    try {
      return this.jsonToDraft(text) ?? { type: "result", payload: { text } };
    } catch {
      return { type: "result", payload: { text } };
    }
  }

  private jsonToDraft(jsonText: string): RunEventDraft | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return jsonText ? { type: "assistant_delta", payload: { text: jsonText } } : undefined;
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.type === "string") {
        const payload =
          obj.payload && typeof obj.payload === "object"
            ? (obj.payload as Record<string, unknown>)
            : obj;
        return { type: obj.type, payload };
      }
      if (typeof obj.text === "string") {
        return { type: "assistant_delta", payload: { text: obj.text } };
      }
      return { type: "result", payload: obj };
    }
    return { type: "assistant_delta", payload: { text: String(parsed) } };
  }

  /** 给了 RunStore 与 runId 时把事件落控制面库，并按终态事件维护 Run 状态。 */
  private persist(runId: string | undefined, draft: RunEventDraft): void {
    if (!this.runs || !runId) return;
    this.runs.addEvent(runId, draft);
    const run = this.runs.getRun(runId);
    if (!run) return;
    if (draft.type === "approval_required" && run.status === "running") {
      this.runs.updateRunStatus(runId, "awaiting_approval");
    } else if (draft.type === "run_done" && run.status !== "done") {
      this.runs.updateRunStatus(runId, "done");
    } else if (draft.type === "run_failed" && run.status !== "failed") {
      this.runs.setRunError(
        runId,
        String(draft.payload.error ?? draft.payload.reason ?? "run_failed"),
      );
      this.runs.updateRunStatus(runId, "failed");
    }
  }

  async *streamEvents(runId: string, afterSeq = 0): AsyncIterable<RunEventRecord> {
    if (!this.runs) return;
    yield* pollStoreEvents(this.runs, runId, afterSeq);
  }

  async cancel(_runId: string): Promise<boolean> {
    // AgentCore 无服务端取消单次调用的 API（同 Python 桩口径返回 false），
    // 取消语义由控制面把 Run 置 cancelled 并停止消费流完成。
    return false;
  }

  async getTrace(runId: string): Promise<RunEventRecord[]> {
    return this.runs ? this.runs.listEvents(runId, 0) : [];
  }

  async health(): Promise<Record<string, unknown>> {
    if (!this.configured) {
      return {
        status: "not_configured",
        runtime: "agentcore",
        region: this.config.region || null,
        hint: AGENTCORE_CONFIG_HINT,
      };
    }
    return {
      status: "ok",
      runtime: "agentcore",
      region: this.config.region,
      transport: "@aws-sdk/client-bedrock-agentcore",
      note: "invoke/stream 已实现 SDK 传输；本期未做真实 AWS 联调。",
    };
  }
}
