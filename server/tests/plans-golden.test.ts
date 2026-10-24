/**
 * 计划器平价 golden 测试（ARCH-3 批次三）：与 Python 端共读同一份用例。
 *
 * 用例正本：仓库根 tests/golden/plans.json；从 server/tests 出发用相对路径
 * ../../tests/golden/plans.json（经 import.meta.url 推导，不依赖进程 cwd）。
 * 断言口径与 Python 端 tests/test_planner_golden.py 相同，只在断言层处理
 * 字段命名差：TS 为 saveAs / needsApproval / amountDefaulted，
 * Python 为 save_as / needs_approval / metadata.amount_defaulted。
 * label 与 cost 不进 golden（两边成本表既有差异属遗留项，不在此断言）。
 * 本文件只读 buildPlan，不改 simulated.ts（TS 为平价正本）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/infrastructure/runtime/simulated.js";

interface GoldenStep {
  tool: string;
  args: Record<string, unknown>;
  save_as: string;
  needs_approval: boolean;
}

interface GoldenCase {
  id: string;
  prompt: string;
  scene: string;
  note?: string;
  expected: {
    tools: string[];
    needs_approval: boolean[];
    amount_defaulted: boolean;
    steps: GoldenStep[];
  };
}

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "golden",
  "plans.json",
);
const cases = (JSON.parse(readFileSync(goldenPath, "utf-8")) as {
  cases: GoldenCase[];
}).cases;

describe("buildPlan golden 平价（与 Python MockModel.plan 共用例）", () => {
  it("用例 id 不重复", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(7);
  });

  for (const c of cases) {
    it(`${c.id}（${c.scene}）：${c.prompt}`, () => {
      const plan = buildPlan(c.scene, c.prompt);
      expect(plan.goal).toBe(c.prompt);
      expect(plan.scene).toBe(c.scene);
      expect(plan.steps.map((s) => s.tool)).toEqual(c.expected.tools);
      expect(plan.steps.map((s) => s.needsApproval)).toEqual(
        c.expected.needs_approval,
      );
      expect(plan.steps.map((s) => s.saveAs)).toEqual(
        c.expected.steps.map((s) => s.save_as),
      );
      for (const [i, step] of plan.steps.entries()) {
        const exp = c.expected.steps[i]!;
        expect(step.tool).toBe(exp.tool);
        expect(step.args).toEqual(exp.args);
        expect(step.needsApproval).toBe(exp.needs_approval);
      }
      expect(plan.amountDefaulted).toBe(c.expected.amount_defaulted);
    });
  }

  it("成对场景计划相同：buy / aave 的 chat 与 script_build", () => {
    const byId = new Map(cases.map((c) => [c.id, c]));
    for (const [chatId, sbId] of [
      ["buy-chat", "buy-script-build"],
      ["aave-chat", "aave-script-build"],
    ] as const) {
      const chat = byId.get(chatId)!;
      const sb = byId.get(sbId)!;
      expect(chat.prompt).toBe(sb.prompt);
      const sig = (scene: string, prompt: string) =>
        buildPlan(scene, prompt).steps.map((s) => [
          s.tool,
          s.args,
          s.needsApproval,
          s.saveAs,
        ]);
      expect(sig("chat", chat.prompt)).toEqual(sig("script_build", sb.prompt));
      expect(buildPlan("chat", chat.prompt).amountDefaulted).toBe(
        buildPlan("script_build", sb.prompt).amountDefaulted,
      );
    }
  });
});
