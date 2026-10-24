"""计划器平价 golden 测试（ARCH-3 批次三）。

用例正本：tests/golden/plans.json（仓库共享，TS 测试共读同一份）。
路径以本文件位置推导仓库根，不写死绝对路径。
断言口径（只在断言层处理两边字段命名差，不改领域模型）：
- Python Step：tool / args / save_as / needs_approval，
  金额默认标记在 Plan.metadata["amount_defaulted"]；
- TS PlanStep 对应字段为 tool / args / saveAs / needsApproval，
  标记在 SimulatedPlan.amountDefaulted（见 server/tests 的同名测试）。
只断言 golden 覆盖的工具顺序、挂审批标志、save_as 与关键参数，
label 与成本不在 golden 内（两边成本表既有差异属遗留项）。
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from muse_me.llm import MockModel  # noqa: E402

GOLDEN = Path(__file__).resolve().parents[1] / "tests" / "golden" / "plans.json"


def _load_cases() -> list[dict]:
    with open(GOLDEN, encoding="utf-8") as fh:
        doc = json.load(fh)
    cases = doc["cases"]
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), f"golden 用例 id 重复：{ids}"
    return cases


class TestPlannerGolden(unittest.TestCase):
    def test_golden_cases_match_mock_plan(self):
        model = MockModel()
        for case in _load_cases():
            with self.subTest(case=case["id"]):
                plan = model.plan(case["scene"], case["prompt"])
                expected = case["expected"]
                self.assertEqual(plan.goal, case["prompt"])
                self.assertEqual(plan.scene, case["scene"])
                self.assertEqual(
                    [s.tool for s in plan.steps], expected["tools"])
                self.assertEqual(
                    [s.needs_approval for s in plan.steps],
                    expected["needs_approval"])
                self.assertEqual(
                    [s.save_as for s in plan.steps],
                    [s["save_as"] for s in expected["steps"]])
                for step, exp_step in zip(plan.steps, expected["steps"]):
                    self.assertEqual(step.tool, exp_step["tool"])
                    # JSON 里的 100 与 Python 的 100.0 在 == 下相等，
                    # 故直接比 dict，不做类型归一化。
                    self.assertEqual(step.args, exp_step["args"])
                    self.assertEqual(
                        step.needs_approval, exp_step["needs_approval"])
                self.assertEqual(
                    plan.metadata["amount_defaulted"],
                    expected["amount_defaulted"])

    def test_golden_paired_scenes_are_identical(self):
        """成对用例（同 prompt、chat/script_build）计划必须逐字相同。

        这是 ARCH-3 的核心断言：场景不再改变意图计划。配对关系由 id
        后缀推导（buy-chat/buy-script-build、aave-chat/aave-script-build），
        若 golden 增删配对导致此处失效，应先检查用例而非放宽断言。
        """
        model = MockModel()
        by_id = {c["id"]: c for c in _load_cases()}
        for chat_id, sb_id in (("buy-chat", "buy-script-build"),
                               ("aave-chat", "aave-script-build")):
            with self.subTest(pair=f"{chat_id}/{sb_id}"):
                self.assertEqual(by_id[chat_id]["prompt"], by_id[sb_id]["prompt"])
                p_chat = model.plan("chat", by_id[chat_id]["prompt"])
                p_sb = model.plan("script_build", by_id[sb_id]["prompt"])
                sig = lambda p: [(s.tool, s.args, s.needs_approval, s.save_as)  # noqa: E731
                                 for s in p.steps]
                self.assertEqual(sig(p_chat), sig(p_sb))
                self.assertEqual(p_chat.metadata["amount_defaulted"],
                                 p_sb.metadata["amount_defaulted"])


if __name__ == "__main__":
    unittest.main()
