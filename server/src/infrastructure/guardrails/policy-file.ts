import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAIL_CLOSED_GUARDRAIL_POLICY,
  type GuardrailPolicy,
} from "../../domain/types.js";

/**
 * 护栏单真值源：启动时解析仓库 harness/guardrails/policy.md。
 *
 * 与 Python harness_files.load_guardrails 同口径：
 * - 文件整体缺失、解析失败、缺必需键、风险处置非法 → 一律 fail-closed
 *  （限额归零、全部单独审批），不再静默回落出厂默认值；
 * - fail-closed 仍保留 approval_timeout_minutes=60（文档化默认值），
 *   避免文件一丢就把全部待审批瞬间过期。
 * 路径解析：env MUSE_ME_HARNESS_ROOT 优先；否则从本文件向上找
 * guardrails/policy.md（src 布局与 dist 布局都适用）；都找不到即 fail-closed。
 */

const REQUIRED_KEYS = [
  "max_cost_per_run_usd",
  "max_cost_per_day_usd",
  "max_sim_amount_usd",
  "approval_timeout_minutes",
] as const;

const REQUIRED_RISKS = ["read", "write", "irreversible"] as const;

const ALLOWED_ACTIONS = new Set([
  "auto",
  "batch_approval",
  "single_approval",
  "deny",
]);

export interface PolicyLoadResult {
  policy: GuardrailPolicy;
  /** "file" 表示读到了 policy.md；"fail-closed" 表示缺失/残缺/非法。 */
  source: "file" | "fail-closed";
  reason: string;
}

export function resolveHarnessRoot(configured = ""): string | undefined {
  if (configured.trim()) {
    const root = path.resolve(configured.trim());
    return existsSync(path.join(root, "guardrails", "policy.md"))
      ? root
      : undefined;
  }
  // 向上查找：dir 本身是 harness 根（dir/guardrails/policy.md），
  // 或 dir 是仓库根（dir/harness/guardrails/policy.md → 返回 dir/harness）。
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(dir, "guardrails", "policy.md"))) return dir;
    if (existsSync(path.join(dir, "harness", "guardrails", "policy.md"))) {
      return path.join(dir, "harness");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function parsePolicyFile(text: string): GuardrailPolicy {
  const match = text.match(/```policy\s*\n([\s\S]*?)```/);
  if (!match) throw new Error("policy.md 缺少 ```policy 代码块");
  const seen = new Set<string>();
  const risks: Record<string, string> = {};
  let section: string | undefined;
  // 与 Python dataclass 默认一致：未写 approval_default 时取 deny，不算残缺。
  let approvalDefault = "deny";
  const values: Record<string, number> = {};
  for (const rawLine of match[1]!.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw!.trim();
    const value = rest.join(":").trim();
    if (indent === 0) {
      section = value === "" ? key : undefined;
      if (value === "") continue;
      seen.add(key);
      if (key === "approval_default") {
        approvalDefault = value;
      } else if ((REQUIRED_KEYS as readonly string[]).includes(key)) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          throw new Error(`policy.md 数值非法：${key}=${value}`);
        }
        values[key] = num;
      }
    } else if (section === "risk_levels") {
      risks[key] = value;
    }
  }
  const missing = REQUIRED_KEYS.filter((k) => !seen.has(k));
  const missingRisks = REQUIRED_RISKS.filter((r) => !(r in risks));
  if (missing.length > 0 || missingRisks.length > 0) {
    throw new Error(
      `policy.md 残缺（缺键 ${missing.join(",")}、缺风险级 ${missingRisks.join(",")}），拒绝以出厂默认值运行`,
    );
  }
  const badRisks = REQUIRED_RISKS.filter((r) => !ALLOWED_ACTIONS.has(risks[r]!));
  if (badRisks.length > 0 || !ALLOWED_ACTIONS.has(approvalDefault)) {
    throw new Error(
      `policy.md 风险处置非法（${badRisks.join(",")}、approval_default=${approvalDefault}），拒绝运行`,
    );
  }
  const timeout = values["approval_timeout_minutes"]!;
  if (timeout <= 0) {
    throw new Error("policy.md 的 approval_timeout_minutes 须为正数");
  }
  return {
    maxCostPerRunUsd: values["max_cost_per_run_usd"]!,
    maxCostPerDayUsd: values["max_cost_per_day_usd"]!,
    maxSimAmountUsd: values["max_sim_amount_usd"]!,
    approvalTimeoutMinutes: timeout,
    riskLevels: {
      read: risks["read"]!,
      write: risks["write"]!,
      irreversible: risks["irreversible"]!,
    },
    approvalDefault,
  };
}

export function loadGuardrailPolicy(configuredRoot = ""): PolicyLoadResult {
  const root = resolveHarnessRoot(configuredRoot);
  if (!root) {
    return {
      policy: FAIL_CLOSED_GUARDRAIL_POLICY,
      source: "fail-closed",
      reason: "harness 目录未找到（MUSE_ME_HARNESS_ROOT 或向上查找均失败）",
    };
  }
  try {
    const text = readFileSync(path.join(root, "guardrails", "policy.md"), "utf-8");
    return { policy: parsePolicyFile(text), source: "file", reason: root };
  } catch (err) {
    return {
      policy: FAIL_CLOSED_GUARDRAIL_POLICY,
      source: "fail-closed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
