import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadGuardrailPolicy,
  parsePolicyFile,
} from "../src/infrastructure/guardrails/policy-file.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function writePolicy(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "museme-policy-"));
  mkdirSync(path.join(dir, "guardrails"));
  writeFileSync(
    path.join(dir, "guardrails", "policy.md"),
    `# 护栏\n\`\`\`policy\n${body}\`\`\`\n`,
    "utf-8",
  );
  return dir;
}

const FULL_BODY = [
  "max_cost_per_run_usd: 1.00",
  "max_cost_per_day_usd: 10.00",
  "max_sim_amount_usd: 1000",
  "approval_timeout_minutes: 60",
  "risk_levels:",
  "  read: auto",
  "  write: batch_approval",
  "  irreversible: single_approval",
  "approval_default: deny",
].join("\n");

describe("护栏单真值源：解析仓库 policy.md", () => {
  it("解析仓库真实 policy.md 得到与 Python 一致的数值", () => {
    const { policy, source } = loadGuardrailPolicy(
      path.join(REPO_ROOT, "harness"),
    );
    expect(source).toBe("file");
    expect(policy.maxCostPerRunUsd).toBe(1.0);
    expect(policy.maxCostPerDayUsd).toBe(10.0);
    expect(policy.maxSimAmountUsd).toBe(1000);
    expect(policy.approvalTimeoutMinutes).toBe(60);
    expect(policy.riskLevels).toEqual({
      read: "auto",
      write: "batch_approval",
      irreversible: "single_approval",
    });
    expect(policy.approvalDefault).toBe("deny");
  });

  it("缺一键（approval_timeout_minutes）→ fail-closed：零限额、全单独审批", () => {
    const body = FULL_BODY.replace("approval_timeout_minutes: 60\n", "");
    const { policy, source } = loadGuardrailPolicy(writePolicy(body));
    expect(source).toBe("fail-closed");
    expect(policy.maxCostPerRunUsd).toBe(0);
    expect(policy.maxCostPerDayUsd).toBe(0);
    expect(policy.maxSimAmountUsd).toBe(0);
    expect(policy.riskLevels).toEqual({
      read: "single_approval",
      write: "single_approval",
      irreversible: "single_approval",
    });
    expect(policy.approvalDefault).toBe("deny");
  });

  it("缺风险级 / 风险处置非法 → fail-closed", () => {
    const noRisk = FULL_BODY.replace("  irreversible: single_approval\n", "");
    expect(loadGuardrailPolicy(writePolicy(noRisk)).source).toBe("fail-closed");
    const badAction = FULL_BODY.replace("read: auto", "read: whatever");
    expect(loadGuardrailPolicy(writePolicy(badAction)).source).toBe("fail-closed");
  });

  it("文件缺失 → fail-closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "museme-policy-empty-"));
    const { policy, source } = loadGuardrailPolicy(dir);
    expect(source).toBe("fail-closed");
    expect(policy.maxCostPerRunUsd).toBe(0);
  });

  it("parsePolicyFile：数值非法抛错（由 load 层转为 fail-closed）", () => {
    expect(() =>
      parsePolicyFile(
        "```policy\nmax_cost_per_run_usd: abc\n```",
      ),
    ).toThrow();
  });
});
