import { randomUUID } from "node:crypto";
import {
  GuardrailDenied,
  InvalidTransition,
  NotFound,
  ValidationFailed,
} from "../domain/errors.js";
import { findAmount, findToken } from "../domain/extract.js";
import type {
  ApprovalStore,
  FeedStore,
  RunStore,
  ScriptStore,
  ToolRegistryPort,
} from "../domain/ports.js";
import { AAVE_RATES, TOOL_DEFS } from "../domain/tool-catalog.js";
import {
  actionForRisk,
  type FeedItemRecord,
  type GuardrailPolicy,
  type RunRecord,
  type ScriptDoc,
  type ScriptRecord,
} from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";

/**
 * 脚本引擎（移植 Python scripts_engine.py 现行版）：
 * 草稿构建 / DSL 校验 / 试运行 / 正式执行 / 审批续跑。
 *
 * 审批语义：门位 = doc.requires_approval_before_step 显式指定 + 全部非 auto
 * 风险步（每步各自挂起/审批）。走到门位查 (run_id, step_index) 的审批：
 * 无则建 Approval 并挂起；pending 保持挂起；approved 放行；denied 失败收口。
 * 试运行不建审批、不挂起，写工具一律 simulate 跑完。
 *
 * 金额护栏（执行前）：args 按工具 schema 数值化（字符串须能数值化才放行，
 * 非数值字符串/bool/复合类型拒绝——堵「金额加引号绕过」）；数值化后的
 * amount_usd/amount 超 maxSimAmountUsd 拦截；轮/日花费在每步执行**前**检查。
 * 续跑从 run_events 重建已完成步/事实板/已花费（事件即快照，重启不丢），
 * 且先断言 Run 处于 awaiting_approval，钉住 plan_created 记录的脚本版本。
 */

export interface ScriptRunStepResult {
  step: number;
  tool: string;
  result: Record<string, unknown>;
}

export interface ScriptRunResult {
  run_id: string;
  status: string;
  facts: Record<string, unknown>;
  steps: ScriptRunStepResult[];
  spent_usd: number;
  approval_id?: string;
  error?: string;
}

export interface RunScriptOptions {
  script: ScriptRecord;
  params?: Record<string, unknown>;
  trial?: boolean;
  source?: string;
  jobId?: string | null;
  entity?: Record<string, unknown> | null;
  doc?: ScriptDoc;
}

const INTERP_RE = /\$\{([^{}]+)\}/g;
const INTERP_FULL_RE = /^\$\{([^{}]+)\}$/;
const EXPR_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AMOUNT_KEYS = ["amount_usd", "amount"] as const;
/** 步成本预估（执行前预算检查用）：统一 0.01 保守估，同 Python。 */
const STEP_COST_ESTIMATE = 0.01;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Python repr 的近似（错误消息用）：字符串带单引号、bool/None 用 Python 写法。 */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? String(value);
}

/** Python str(float) 口径：整数值浮点渲染 "1000.0"（护栏消息用）。 */
function pyNum(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function effectiveSteps(doc: ScriptDoc): Array<Record<string, unknown>> {
  const steps = [...(Array.isArray(doc.steps) ? doc.steps : [])] as Array<
    Record<string, unknown>
  >;
  if (doc.final_step) steps.push(doc.final_step as Record<string, unknown>);
  return steps;
}

export class ScriptEngine {
  constructor(
    private readonly runs: RunStore,
    private readonly approvals: ApprovalStore,
    private readonly scripts: ScriptStore,
    private readonly feed: FeedStore,
    private readonly tools: ToolRegistryPort,
    private readonly policy: GuardrailPolicy,
    private readonly userId: string,
  ) {}

  // ------------------------------------------------------------ 草稿构建
  buildDraft(
    intent: string,
    feedItem?: FeedItemRecord | null,
  ): ScriptDoc {
    const text = intent ?? "";
    const entities: Record<string, unknown> = feedItem
      ? { ...(feedItem.entities ?? {}) }
      : {};
    const newsTitle = feedItem?.title ?? "";
    const feedTopic = feedItem?.topic ?? "";
    const haystack = `${text} ${newsTitle}`;
    const lowered = haystack.toLowerCase();
    // Aave 分支要有 Aave 语境证据（意图/标题明说 Aave，或条目本身是 Aave
    // 协议条目）；或意图原文含利率/收益/存入/借贷（同 Python 条件）。
    const aaveContext =
      lowered.includes("aave") ||
      String(entities.protocol ?? "").toLowerCase() === "aave";
    if (
      aaveContext ||
      ["利率", "收益", "存入", "借贷"].some((k) => text.includes(k))
    ) {
      const asset = this.aaveAsset(text, entities);
      return {
        name: "Aave 收益脚本",
        description: "查 Aave 利率并模拟存入测算收益（只模拟，不动真钱）。",
        params: [
          { key: "asset", label: "资产", type: "string", default: asset },
          { key: "amount_usd", label: "存入金额（美元）", type: "number", default: 1000 },
          { key: "days", label: "测算天数", type: "number", default: 365 },
        ],
        steps: [
          { tool: "aave.rates", args: { asset: "${asset}" }, save_as: "rates" },
        ],
        requires_approval_before_step: 1,
        final_step: {
          tool: "aave.sim_supply",
          args: { asset: "${asset}", amount_usd: "${amount_usd}", days: "${days}" },
        },
      };
    }
    // OKX 分支（真实交易所，默认模拟盘）：只认显式信号，不抢默认
    // 买入路径——只说「买 BTC」仍走下面的 meme 模拟骨架；说「用 OKX
    // 买」「现货」「永续/做多/做空」才走这里。执行环境由 OKX 配置定，
    // 未配置时运行到下单步会如实拒绝，不静默回退模拟。
    const perpSignal = ["做多", "做空", "永续", "合约"].some((k) => text.includes(k));
    const spotSignal =
      lowered.includes("okx") || ["现货", "交易所"].some((k) => text.includes(k));
    if (perpSignal || spotSignal) {
      const rawToken =
        (entities.token ? String(entities.token) : "") || findToken(haystack) || "BTC";
      const tokenUpper = rawToken.toUpperCase();
      const amount = findAmount(haystack).amount;
      if (perpSignal) {
        const instId = tokenUpper.includes("-") ? tokenUpper : `${tokenUpper}-USDT-SWAP`;
        const side = text.includes("做空") ? "short" : "long";
        return {
          name: `OKX 永续${side === "short" ? "做空" : "做多"}`,
          description: "查行情 → 审批后在 OKX 模拟盘市价开仓（不动真钱）。",
          params: [
            { key: "inst_id", label: "合约", type: "string", default: instId },
            { key: "side", label: "方向（long/short）", type: "string", default: side },
            { key: "amount_usd", label: "金额（美元）", type: "number", default: amount },
          ],
          steps: [{ tool: "okx.ticker", args: { inst_id: "${inst_id}" }, save_as: "tick" }],
          requires_approval_before_step: 1,
          final_step: {
            tool: "okx.perp_order",
            args: { inst_id: "${inst_id}", side: "${side}", amount_usd: "${amount_usd}" },
          },
        };
      }
      const instId = tokenUpper.includes("-") ? tokenUpper : `${tokenUpper}-USDT`;
      const side = text.includes("卖出") ? "sell" : "buy";
      return {
        name: `OKX 现货${side === "sell" ? "卖出" : "买入"}`,
        description: "查行情 → 审批后在 OKX 模拟盘市价成交（不动真钱）。",
        params: [
          { key: "inst_id", label: "交易对", type: "string", default: instId },
          { key: "side", label: "方向（buy/sell）", type: "string", default: side },
          { key: "amount_usd", label: "金额（美元）", type: "number", default: amount },
        ],
        steps: [{ tool: "okx.ticker", args: { inst_id: "${inst_id}" }, save_as: "tick" }],
        requires_approval_before_step: 1,
        final_step: {
          tool: "okx.spot_order",
          args: { inst_id: "${inst_id}", side: "${side}", amount_usd: "${amount_usd}" },
        },
      };
    }
    // meme 骨架：标的/金额抽取复用计划器口径（findToken/findAmount）。
    const planToken = findToken(haystack) ?? "BONK";
    const amount = findAmount(haystack).amount;
    let token = planToken;
    if (entities.token) {
      token = String(entities.token);
    } else if (token && !haystack.toUpperCase().includes(token.toUpperCase())) {
      // plan 给的标的在用户文本/新闻标题里从未出现（模型默认回退）→ 不采信。
      token = "";
    }
    const notes: string[] = [];
    const tokenParam: Record<string, unknown> = {
      key: "token",
      label: "代币",
      type: "string",
    };
    if (entities.token) {
      tokenParam.default = "${entity.token}";
    } else if (token) {
      tokenParam.default = token;
    } else {
      tokenParam.required = true;
      notes.push("未识别标的：token 为必填参数，运行前须由用户指定代币。");
    }
    if (feedTopic === "meme" || lowered.includes("meme")) {
      // meme 语境明确，无需额外标注
    } else if (!entities.token && !token) {
      notes.push("意图未指向明确标的，本草稿为通用骨架，保存前请确认用途。");
    }
    const draft: ScriptDoc = {
      name: "新闻驱动 meme 买入",
      description: "从新闻定位 meme 标的：查流动性与风险 → 报价 → 审批后模拟成交。",
      params: [
        { key: "amount_usd", label: "买入金额（美元）", type: "number", default: amount },
        tokenParam,
      ],
      steps: [
        { tool: "meme.scan", args: { token: "${token}" }, save_as: "scan" },
        {
          tool: "dex.quote",
          args: { token: "${token}", amount_usd: "${amount_usd}" },
          save_as: "quote",
        },
      ],
      requires_approval_before_step: 2,
      final_step: {
        tool: "dex.sim_swap",
        args: { token: "${token}", amount_usd: "${amount_usd}" },
      },
    };
    if (notes.length > 0) draft.notes = notes;
    if (Object.keys(entities).length > 0) draft.entity = entities;
    return draft;
  }

  /** Aave 草稿的 asset：只认 Aave 已收录资产，否则回退 USDC（同 Python _aave_asset）。 */
  private aaveAsset(text: string, entities: Record<string, unknown>): string {
    const haystack = `${text} ${String(entities.token ?? "")}`.toUpperCase();
    for (const asset of Object.keys(AAVE_RATES)) {
      if (haystack.includes(asset)) return asset;
    }
    const token = String(entities.token ?? "").toUpperCase();
    return token in AAVE_RATES ? token : "USDC";
  }

  // ------------------------------------------------------------ DSL 校验
  validateScript(doc: unknown): ScriptDoc {
    if (!isPlainObject(doc)) throw new ValidationFailed("脚本必须是 JSON 对象");
    const name = doc.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new ValidationFailed("脚本缺少 name");
    }
    const params = (doc.params ?? []) as unknown;
    if (!Array.isArray(params)) throw new ValidationFailed("params 必须是数组");
    const paramKeys = new Set<string>();
    for (const p of params) {
      if (!isPlainObject(p) || !p.key) {
        throw new ValidationFailed(`参数定义不合法：${pyRepr(p)}`);
      }
      const type = typeof p.type === "string" ? p.type : "string";
      if (type !== "string" && type !== "number") {
        throw new ValidationFailed(`参数 ${String(p.key)} 的 type 只允许 string/number`);
      }
      paramKeys.add(String(p.key));
    }
    const steps = effectiveSteps(doc);
    if (steps.length === 0) {
      throw new ValidationFailed("脚本至少需要一步（steps 或 final_step）");
    }
    const saveAsSeen = new Set<string>();
    steps.forEach((step, i) => {
      if (!isPlainObject(step)) throw new ValidationFailed(`第 ${i} 步必须是对象`);
      const tool = step.tool;
      if (typeof tool !== "string" || !TOOL_DEFS.has(tool)) {
        throw new ValidationFailed(`第 ${i} 步工具不在白名单：${String(tool)}`);
      }
      const args = (step.args ?? {}) as unknown;
      if (!isPlainObject(args)) throw new ValidationFailed(`第 ${i} 步 args 必须是对象`);
      const allowed = new Set([...paramKeys, ...saveAsSeen, "entity"]);
      this.checkInterpolations(args, allowed, `第 ${i} 步`);
      const saveAs = step.save_as;
      if (saveAs) {
        if (!IDENT_RE.test(String(saveAs))) {
          throw new ValidationFailed(`第 ${i} 步 save_as 不合法：${String(saveAs)}`);
        }
        if (saveAsSeen.has(String(saveAs))) {
          throw new ValidationFailed(`save_as 重复：${String(saveAs)}`);
        }
        saveAsSeen.add(String(saveAs));
      }
    });
    for (const p of params as Array<Record<string, unknown>>) {
      this.checkInterpolations(
        p.default,
        new Set([...paramKeys, "entity"]),
        `参数 ${String(p.key)} 默认值`,
      );
    }
    const gate = doc.requires_approval_before_step;
    if (gate !== undefined && gate !== null) {
      if (
        typeof gate !== "number" ||
        !Number.isInteger(gate) ||
        gate < 0 ||
        gate > steps.length
      ) {
        throw new ValidationFailed(
          `requires_approval_before_step 须为 0..${steps.length} 的整数`,
        );
      }
    }
    return doc;
  }

  private checkInterpolations(
    value: unknown,
    allowedHeads: Set<string>,
    where: string,
  ): void {
    if (typeof value === "string") {
      for (const match of value.matchAll(INTERP_RE)) {
        const expr = match[1]!;
        if (!EXPR_RE.test(expr)) {
          throw new ValidationFailed(`${where} 含非法插值表达式：\${${expr}}`);
        }
        const head = expr.split(".", 1)[0]!;
        if (!allowedHeads.has(head)) {
          throw new ValidationFailed(
            `${where} 插值 \${${expr}} 引用了未定义的名字：${head}`,
          );
        }
      }
      const stripped = value.replace(INTERP_RE, "");
      if (stripped.includes("${")) {
        throw new ValidationFailed(`${where} 含未闭合插值：${value}`);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const v of Object.values(value)) this.checkInterpolations(v, allowedHeads, where);
    } else if (Array.isArray(value)) {
      for (const v of value) this.checkInterpolations(v, allowedHeads, where);
    }
  }

  /** 门位集合：显式 gate + 全部非 auto 风险步（同 Python gate_steps）。 */
  gateSteps(doc: ScriptDoc): Set<number> {
    const gates = new Set<number>();
    const gate = doc.requires_approval_before_step;
    if (typeof gate === "number" && Number.isInteger(gate)) gates.add(gate);
    effectiveSteps(doc).forEach((step, i) => {
      const tool = typeof step.tool === "string" ? TOOL_DEFS.get(step.tool) : undefined;
      if (tool && actionForRisk(this.policy, tool.risk) !== "auto") gates.add(i);
    });
    return gates;
  }

  // ------------------------------------------------------------ 执行入口
  async runScript(options: RunScriptOptions): Promise<ScriptRunResult> {
    const { script } = options;
    const doc = options.doc ?? script.doc;
    this.validateScript(doc);
    const now = nowIso();
    const run: RunRecord = {
      id: randomUUID(),
      userId: this.userId,
      chatId: null,
      scriptId: script.id,
      jobId: options.jobId ?? null,
      scene: "script",
      source: options.source ?? "script",
      status: "running",
      costUsd: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    };
    this.runs.createRun(run);
    let entity: Record<string, unknown> =
      options.entity && Object.keys(options.entity).length > 0
        ? { ...options.entity }
        : isPlainObject(doc.entity)
          ? { ...doc.entity }
          : {};
    if (Object.keys(entity).length === 0 && script.originFeedItemId) {
      const item = this.feed.getFeedItem(script.originFeedItemId);
      if (item) entity = { ...(item.entities ?? {}) };
    }
    const merged = this.mergedParams(doc, options.params, entity);
    this.emit(run.id, "plan_created", {
      script_id: script.id,
      script_name: script.name,
      version: script.currentVersion,
      steps: effectiveSteps(doc).length,
      params: merged,
      entity,
      trial: Boolean(options.trial),
    });
    return this.execute({
      run,
      doc,
      params: merged,
      entity,
      trial: Boolean(options.trial),
      completed: new Set(),
      facts: {},
      spent: 0,
      results: [],
    });
  }

  /**
   * 审批后续跑：先断言 awaiting_approval（在任何工具执行/状态变更前），
   * 再从 plan_created 钉住的版本与 run_events 重建状态继续执行。
   */
  async resumeScript(runId: string): Promise<ScriptRunResult> {
    const run = this.runs.getRun(runId);
    if (!run || !run.scriptId) throw new NotFound(`脚本运行不存在：${runId}`);
    if (run.status !== "awaiting_approval") {
      throw new InvalidTransition(
        `只有 awaiting_approval 的运行可续跑，当前状态：${run.status}`,
      );
    }
    const script = this.scripts.getScript(run.scriptId);
    if (!script) throw new NotFound(`脚本不存在：${run.scriptId}`);
    const events = this.runs.listEvents(runId, 0);
    const planEvent = events.find((e) => e.type === "plan_created");
    if (!planEvent) throw new NotFound(`运行缺少 plan_created 事件：${runId}`);
    const saved = planEvent.payload ?? {};
    const savedVersion = saved.version;
    const version =
      typeof savedVersion === "number" && savedVersion
        ? savedVersion
        : script.currentVersion;
    const versioned = this.scripts.getScriptVersion(script.id, version);
    const doc = versioned ? versioned.doc : script.doc;
    const params = isPlainObject(saved.params) ? { ...saved.params } : {};
    const entity = isPlainObject(saved.entity) ? { ...saved.entity } : {};
    const trial = Boolean(saved.trial);
    const completed = new Set<number>();
    const facts: Record<string, unknown> = {};
    const results: ScriptRunStepResult[] = [];
    let spent = 0;
    for (const ev of events) {
      if (ev.type !== "step_done") continue;
      const idx = Number(ev.payload.step ?? -1);
      completed.add(idx);
      spent += Number(ev.payload.cost_usd ?? 0) || 0;
      if (ev.payload.save_as) {
        facts[String(ev.payload.save_as)] = ev.payload.result;
      }
      results.push({
        step: idx,
        tool: String(ev.payload.tool ?? ""),
        result: isPlainObject(ev.payload.result)
          ? ev.payload.result
          : (ev.payload.result as Record<string, unknown>),
      });
    }
    this.runs.updateRunStatus(runId, "running");
    const fresh = this.runs.getRun(runId) ?? run;
    return this.execute({
      run: fresh,
      doc,
      params,
      entity,
      trial,
      completed,
      facts,
      spent,
      results,
    });
  }

  // ------------------------------------------------------------ 执行核心
  private async execute(state: {
    run: RunRecord;
    doc: ScriptDoc;
    params: Record<string, unknown>;
    entity: Record<string, unknown>;
    trial: boolean;
    completed: Set<number>;
    facts: Record<string, unknown>;
    spent: number;
    results: ScriptRunStepResult[];
  }): Promise<ScriptRunResult> {
    const { run, doc, params, entity, trial, completed, facts, results } = state;
    let spent = state.spent;
    const steps = effectiveSteps(doc);
    const gates = this.gateSteps(doc);
    const context: Record<string, unknown> = { ...params, ...facts, entity };

    const finish = (status: string, extra: Partial<ScriptRunResult> = {}): ScriptRunResult => ({
      run_id: run.id,
      status,
      facts,
      steps: results,
      spent_usd: round6(spent),
      ...extra,
    });

    for (let i = 0; i < steps.length; i++) {
      if (completed.has(i)) continue;
      const step = steps[i]!;
      const toolName = String(step.tool);
      const tool = TOOL_DEFS.get(toolName);
      let resolved = this.resolve(step.args ?? {}, context) as Record<string, unknown>;
      // 0) 按工具 schema 数值化（堵字符串金额绕过）：失败即护栏拒绝
      try {
        resolved = this.coerceNumericArgs(toolName, resolved);
      } catch (err) {
        if (err instanceof ValidationFailed) {
          this.failGuardrail(run, i, toolName, err.message);
        }
        throw err;
      }
      // 1) 金额护栏（数值化后、执行前）
      for (const key of AMOUNT_KEYS) {
        const value = resolved[key];
        if (typeof value === "number" && value > this.policy.maxSimAmountUsd) {
          this.failGuardrail(
            run, i, toolName,
            `金额 ${pyNum(value)} 超过模拟上限 ${pyNum(this.policy.maxSimAmountUsd)}，已拦截`,
          );
        }
      }
      if (tool && actionForRisk(this.policy, tool.risk) === "deny") {
        this.failGuardrail(
          run, i, toolName,
          `护栏策略拒绝执行 ${toolName}（风险 ${tool.risk}）`,
        );
      }
      // 2) 花费硬顶步前检查（轮限 + 日限）
      if (spent + STEP_COST_ESTIMATE > this.policy.maxCostPerRunUsd) {
        this.emit(run.id, "run_failed", {
          reason: "budget",
          step: i,
          tool: toolName,
          spent_usd: round6(spent),
          estimate_usd: STEP_COST_ESTIMATE,
          limit_usd: this.policy.maxCostPerRunUsd,
        });
        this.runs.setRunError(run.id, "budget");
        this.runs.updateRunStatus(run.id, "failed");
        return finish("failed", { error: "budget" });
      }
      const daySpent = this.spentToday(run.id);
      if (daySpent + spent + STEP_COST_ESTIMATE > this.policy.maxCostPerDayUsd) {
        const message =
          `今日已花费 ${(daySpent + spent).toFixed(4)} + 本步预估 ` +
          `${STEP_COST_ESTIMATE.toFixed(4)} 超过日硬顶 ${pyNum(this.policy.maxCostPerDayUsd)}`;
        this.emit(run.id, "run_failed", {
          reason: "guardrail",
          step: i,
          tool: toolName,
          error: message,
          day_spent_usd: round6(daySpent + spent),
          limit_usd: this.policy.maxCostPerDayUsd,
        });
        this.runs.setRunError(run.id, "guardrail: daily budget");
        this.runs.updateRunStatus(run.id, "failed");
        throw new GuardrailDenied(message);
      }
      // 3) 审批门
      if (gates.has(i) && !trial) {
        const approval = this.findApproval(run.id, i);
        if (!approval) {
          let amount: number | null = null;
          for (const key of AMOUNT_KEYS) {
            if (typeof resolved[key] === "number") {
              amount = resolved[key] as number;
              break;
            }
          }
          const created = {
            id: randomUUID(),
            runId: run.id,
            stepIndex: i,
            action: toolName,
            risk: tool?.risk ?? "write",
            amountUsd: amount,
            status: "pending" as const,
            reason: "",
            createdAt: nowIso(),
            decidedAt: "",
          };
          this.approvals.createApproval(created);
          this.emit(run.id, "approval_required", {
            step: i,
            tool: toolName,
            approval_id: created.id,
          });
          this.runs.updateRunStatus(run.id, "awaiting_approval");
          return finish("awaiting_approval", { approval_id: created.id });
        }
        if (approval.status === "pending") {
          return finish("awaiting_approval", { approval_id: approval.id });
        }
        if (approval.status === "denied") {
          this.emit(run.id, "run_failed", {
            reason: "denied",
            step: i,
            tool: toolName,
            error: approval.reason || "用户拒绝",
          });
          this.runs.updateRunStatus(run.id, "failed");
          return finish("failed", { error: "denied" });
        }
      }
      // 4) 执行本步
      this.emit(run.id, "step_started", { step: i, tool: toolName });
      this.emit(run.id, "tool_called", { step: i, tool: toolName, args: resolved });
      let result: Record<string, unknown>;
      try {
        // 试运行（trial）一律 simulate（下单工具只出预览）；正式运行传
        // execute（下单工具真实执行，环境仍由工具自身配置定）。
        const raw = await this.tools.call(
          toolName,
          resolved,
          trial ? "simulate" : "execute",
        );
        result = isPlainObject(raw) ? raw : { value: raw };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit(run.id, "step_failed", { step: i, tool: toolName, error: message });
        this.emit(run.id, "run_failed", {
          reason: "step_failed",
          step: i,
          error: message,
        });
        this.runs.setRunError(run.id, message);
        this.runs.updateRunStatus(run.id, "failed");
        return finish("failed", { error: message });
      }
      const cost = Number(result.cost_usd ?? 0) || 0;
      spent += cost;
      if (cost) this.runs.addRunCost(run.id, cost);
      const saveAs = step.save_as;
      if (saveAs) {
        facts[String(saveAs)] = result;
        context[String(saveAs)] = result;
      }
      this.emit(run.id, "step_done", {
        step: i,
        tool: toolName,
        save_as: saveAs ?? null,
        result,
        cost_usd: cost,
      });
      results.push({ step: i, tool: toolName, result });
      if (spent > this.policy.maxCostPerRunUsd) {
        this.emit(run.id, "run_failed", {
          reason: "budget",
          spent_usd: round6(spent),
          limit_usd: this.policy.maxCostPerRunUsd,
        });
        this.runs.setRunError(run.id, "budget");
        this.runs.updateRunStatus(run.id, "failed");
        return finish("failed", { error: "budget" });
      }
    }
    this.emit(run.id, "run_done", {
      facts: Object.keys(facts),
      spent_usd: round6(spent),
    });
    this.runs.updateRunStatus(run.id, "done");
    return finish("done");
  }

  // ------------------------------------------------------------ 内部辅助
  private emit(runId: string, type: string, payload: Record<string, unknown>): void {
    this.runs.addEvent(runId, { type, payload });
  }

  /** 护栏拦截统一收口：先落 run_failed(reason=guardrail) + 置 failed，再抛。 */
  private failGuardrail(
    run: RunRecord,
    step: number,
    toolName: string,
    error: string,
  ): never {
    this.emit(run.id, "run_failed", {
      reason: "guardrail",
      step,
      tool: toolName,
      error,
    });
    this.runs.setRunError(run.id, `guardrail: ${error}`);
    this.runs.updateRunStatus(run.id, "failed");
    throw new GuardrailDenied(error);
  }

  private findApproval(runId: string, stepIndex: number) {
    return this.approvals
      .listApprovals(this.userId)
      .find((ap) => ap.runId === runId && ap.stepIndex === stepIndex);
  }

  /** 今日已花费：当日（UTC 日期前缀）其他 runs 的 cost_usd 汇总，同 Python _spent_today。 */
  private spentToday(excludeRunId: string): number {
    const today = new Date().toISOString().slice(0, 10);
    let total = 0;
    for (const other of this.runs.listRuns(this.userId)) {
      if (other.id === excludeRunId) continue;
      if ((other.createdAt ?? "").slice(0, 10) === today) total += other.costUsd || 0;
    }
    return total;
  }

  /** 工具 schema 中声明为 number 的参数名 ∪ 金额键，逐键数值化（同 Python _coerce_numeric_args）。 */
  private coerceNumericArgs(
    toolName: string,
    resolved: Record<string, unknown>,
  ): Record<string, unknown> {
    const keys = new Set<string>(AMOUNT_KEYS);
    const tool = TOOL_DEFS.get(toolName);
    if (tool) {
      for (const [name, spec] of Object.entries(tool.params)) {
        if (spec.replace(/\?$/, "").trim() === "number") keys.add(name);
      }
    }
    for (const key of keys) {
      if (!(key in resolved) || resolved[key] === null || resolved[key] === undefined) {
        continue;
      }
      const value = resolved[key];
      if (typeof value === "boolean" || typeof value === "object") {
        throw new ValidationFailed(
          `${toolName} 参数 ${key} 需要数字，收到 ${pyRepr(value)}`,
        );
      }
      if (typeof value === "number") continue;
      if (typeof value === "string") {
        const trimmed = value.trim();
        const num = trimmed === "" ? Number.NaN : Number(trimmed);
        if (Number.isNaN(num)) {
          throw new ValidationFailed(
            `${toolName} 参数 ${key} 需要数字，收到 ${pyRepr(value)}`,
          );
        }
        resolved[key] = num;
        continue;
      }
      throw new ValidationFailed(
        `${toolName} 参数 ${key} 需要数字，收到 ${pyRepr(value)}`,
      );
    }
    return resolved;
  }

  /** 参数合併：默认值（可插值）→ 调用方覆盖 → number 型强转 → 必填检查（同 Python _merged_params）。 */
  private mergedParams(
    doc: ScriptDoc,
    overrides: Record<string, unknown> | undefined,
    entity: Record<string, unknown>,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const paramDefs = (Array.isArray(doc.params) ? doc.params : []) as Array<
      Record<string, unknown>
    >;
    for (const p of paramDefs) {
      const key = String(p.key);
      if (p.default !== undefined && p.default !== null) {
        params[key] = this.resolve(p.default, { entity, ...params });
      }
    }
    for (const [key, value] of Object.entries(overrides ?? {})) {
      params[key] = value;
    }
    for (const p of paramDefs) {
      const key = String(p.key);
      if (p.type === "number" && params[key] !== undefined && params[key] !== null) {
        const raw = params[key];
        const num =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" || typeof raw === "boolean"
              ? Number(raw)
              : Number.NaN;
        if (Number.isNaN(num)) {
          throw new ValidationFailed(`参数 ${key} 需要数字，收到 ${pyRepr(raw)}`);
        }
        params[key] = num;
      }
      if ((params[key] === undefined || params[key] === null) && p.required) {
        throw new ValidationFailed(
          `参数 ${key} 为必填且草稿未给默认值，运行前须指定`,
        );
      }
    }
    return params;
  }

  /** 插值解析（同 Python _resolve/_lookup）：整串插值保留原类型，混排插值转字符串。 */
  private resolve(value: unknown, context: Record<string, unknown>): unknown {
    if (typeof value === "string") {
      const full = INTERP_FULL_RE.exec(value);
      if (full) return this.lookup(full[1]!, context);
      return value.replace(INTERP_RE, (_m, expr: string) => {
        const resolved = this.lookup(expr, context);
        return resolved === undefined || resolved === null ? "" : String(resolved);
      });
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.resolve(v, context);
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, context));
    return value;
  }

  private lookup(expr: string, context: Record<string, unknown>): unknown {
    const dot = expr.indexOf(".");
    const head = dot === -1 ? expr : expr.slice(0, dot);
    const rest = dot === -1 ? "" : expr.slice(dot + 1);
    const value = context[head];
    if (isPlainObject(value) && rest) return value[rest];
    return value;
  }
}
