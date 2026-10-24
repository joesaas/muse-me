"""脚本引擎护栏修复回归（评审第一批必修 1/4/5/6 的 scripts_engine+bootstrap 部分）。

覆盖：
- 金额字符串绕过（P0）："99999" 必拦、"50" 数值化放行、"abc" 拒绝且工具零调用；
- 日/轮花费硬顶步前检查：触顶时写步不执行；
- 门位覆盖全部敏感步：两个写步各自挂起；
- resume_script 状态前置：对 failed 的 run 续跑抛 InvalidTransition 且工具零调用；
- build_draft 收敛：无标的不硬编码 BONK（必填+notes）、Aave 资产不拿 meme token；
- bootstrap：catalog 篡改/未知 model/openrouter 缺 key 装配必失败。

零依赖 unittest。运行：python3 -m unittest discover -s tests
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from muse_me import scripts_engine  # noqa: E402
from muse_me.bootstrap import create_app  # noqa: E402
from muse_me.domain import FeedItem  # noqa: E402
from muse_me.errors import DemoError, GuardrailDenied, InvalidTransition, ValidationFailed  # noqa: E402

USER = "demo-user"
REPO_ROOT = Path(__file__).resolve().parents[1]


def fresh_app():
    return create_app({"db_path": ":memory:", "start_scheduler": False})


class CountingMixin:
    """把 app.registry.call 包一层计数，断言工具到底有没有真被调用。"""

    def count_calls(self, app):
        calls: list[str] = []
        orig = app.registry.call

        def counting(name, args=None, mode="simulate"):
            calls.append(name)
            return orig(name, args, mode=mode)

        app.registry.call = counting
        return calls


class TestQuotedAmountGuardrail(CountingMixin, unittest.TestCase):
    """必修 1：args 按工具 schema 数值化，字符串金额不再绕过护栏。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store
        self.calls = self.count_calls(self.app)

    def tearDown(self):
        self.store.close()

    def _doc(self, amount):
        return {
            "name": "引号金额测试脚本",
            "description": "单步报价，金额以字面量写死在 args 里",
            "params": [],
            "steps": [{"tool": "dex.quote",
                       "args": {"token": "BONK", "amount_usd": amount},
                       "save_as": "quote"}],
        }

    def test_quoted_over_amount_blocked(self):
        saved = self.scripts.save_draft(self._doc("99999"))
        with self.assertRaises(GuardrailDenied):
            self.scripts.run(saved.id)
        self.assertEqual(self.calls, [])  # 工具一次都没执行
        run = self.store.list_runs(USER)[0]
        self.assertEqual(run.status.value, "failed")
        last = self.store.list_run_events(run.id)[-1]
        self.assertEqual(last.type, "run_failed")
        self.assertEqual(last.payload.get("reason"), "guardrail")

    def test_quoted_small_amount_coerced_and_passes(self):
        saved = self.scripts.save_draft(self._doc("50"))
        result = self.scripts.trial(saved.id)
        self.assertEqual(result["status"], "done")
        self.assertEqual(self.calls, ["dex.quote"])
        # 数值化后工具收到的是真数字 50.0
        self.assertEqual(result["steps"][0]["result"]["amount_usd"], 50.0)

    def test_non_numeric_amount_rejected(self):
        saved = self.scripts.save_draft(self._doc("abc"))
        with self.assertRaises(GuardrailDenied):
            self.scripts.run(saved.id)
        self.assertEqual(self.calls, [])
        run = self.store.list_runs(USER)[0]
        self.assertEqual(run.status.value, "failed")


class TestBudgetPreStepGate(CountingMixin, unittest.TestCase):
    """必修 2：日/轮硬顶在步前检查，跨界的写步不得执行。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store
        self.calls = self.count_calls(self.app)

    def tearDown(self):
        self.store.close()

    def _doc(self):
        return {
            "name": "多步预算测试脚本",
            "description": "两读一步写，写步在最后",
            "params": [],
            "steps": [
                {"tool": "meme.scan", "args": {"token": "BONK"}, "save_as": "scan"},
                {"tool": "dex.quote",
                 "args": {"token": "BONK", "amount_usd": 50}, "save_as": "quote"},
            ],
            "final_step": {"tool": "dex.sim_swap",
                           "args": {"token": "BONK", "amount_usd": 50}},
        }

    def test_daily_cap_blocks_write_step_before_it_runs(self):
        # 每步实际计费 0.002：两步后已花费 0.004；步前预估 0.01。
        # 日限 0.013 → 写步步前检查 0.004+0.01 > 0.013 触顶，写步不执行。
        self.app.policy.max_cost_per_day_usd = 0.013
        saved = self.scripts.save_draft(self._doc())
        with self.assertRaises(GuardrailDenied):
            self.scripts.run(saved.id)
        self.assertNotIn("dex.sim_swap", self.calls)
        run = self.store.list_runs(USER)[0]
        self.assertEqual(run.status.value, "failed")
        last = self.store.list_run_events(run.id)[-1]
        self.assertEqual(last.payload.get("reason"), "guardrail")

    def test_run_cap_blocks_write_step_before_it_runs(self):
        self.app.policy.max_cost_per_run_usd = 0.013
        saved = self.scripts.save_draft(self._doc())
        result = self.scripts.run(saved.id)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "budget")
        self.assertNotIn("dex.sim_swap", self.calls)


class TestTwoWriteStepsGate(CountingMixin, unittest.TestCase):
    """必修 3：门位覆盖全部敏感步，第二个写步不借第一个的批准通行。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store

    def tearDown(self):
        self.store.close()

    def test_second_write_step_gates_again(self):
        doc = {
            "name": "双写步测试脚本",
            "description": "两个写步各自审批",
            "params": [],
            "steps": [
                {"tool": "dex.sim_swap",
                 "args": {"token": "BONK", "amount_usd": 50}},
                {"tool": "aave.sim_supply",
                 "args": {"asset": "USDC", "amount_usd": 50, "days": 30}},
            ],
        }
        saved = self.scripts.save_draft(doc)
        result = self.scripts.run(saved.id)
        self.assertEqual(result["status"], "awaiting_approval")
        pending = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].step_index, 0)

        self.app.services["approvals"].decide(pending[0].id, True)
        run = self.store.get_run(result["run_id"])
        # 第一个写步已执行，第二个写步再次挂起，不许直接通行
        self.assertEqual(run.status.value, "awaiting_approval")
        done_steps = {e.payload.get("step") for e in self.store.list_run_events(run.id)
                      if e.type == "step_done"}
        self.assertEqual(done_steps, {0})
        pending2 = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending2), 1)
        self.assertEqual(pending2[0].step_index, 1)

        self.app.services["approvals"].decide(pending2[0].id, True)
        run = self.store.get_run(result["run_id"])
        self.assertEqual(run.status.value, "done")
        done_steps = {e.payload.get("step") for e in self.store.list_run_events(run.id)
                      if e.type == "step_done"}
        self.assertEqual(done_steps, {0, 1})


class TestResumePrecondition(CountingMixin, unittest.TestCase):
    """必修 4：resume_script 只许 awaiting_approval，failed 的 run 零工具调用。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store
        self.calls = self.count_calls(self.app)

    def tearDown(self):
        self.store.close()

    def test_resume_failed_run_raises_without_tool_calls(self):
        doc = {
            "name": "必失败脚本",
            "description": "金额超限，第一步就被护栏拦下",
            "params": [],
            "steps": [{"tool": "dex.quote",
                       "args": {"token": "BONK", "amount_usd": 99999}}],
        }
        saved = self.scripts.save_draft(doc)
        with self.assertRaises(GuardrailDenied):
            self.scripts.run(saved.id)
        run = self.store.list_runs(USER)[0]
        self.assertEqual(run.status.value, "failed")
        self.calls.clear()
        with self.assertRaises(InvalidTransition):
            scripts_engine.resume_script(
                self.store, self.app.registry, self.app.policy, run_id=run.id)
        self.assertEqual(self.calls, [])


class TestBuildDraftConvergence(unittest.TestCase):
    """必修 5：无标的不硬编码 BONK；Aave 资产不拿 meme token 顶替。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store

    def tearDown(self):
        self.store.close()

    def test_unrelated_intent_leaves_token_required_with_notes(self):
        draft = self.scripts.build_draft("看看天气怎么样")
        token_param = next(p for p in draft["params"] if p["key"] == "token")
        self.assertNotIn("default", token_param)
        self.assertTrue(token_param.get("required"))
        self.assertTrue(any("未识别标的" in n for n in draft.get("notes", [])))
        saved = self.scripts.save_draft(draft)  # 草稿可保存
        with self.assertRaises(ValidationFailed):
            self.scripts.run(saved.id)  # 运行时缺参明确报错
        result = self.scripts.run(saved.id, params={"token": "SOL"})
        self.assertEqual(result["status"], "awaiting_approval")

    def test_meme_title_with_yield_word_stays_meme_draft(self):
        item = FeedItem(user_id=USER, title="某 meme 币收益翻倍引关注",
                        summary="社区热度高", entities={"token": "BONK"})
        draft = self.scripts.build_draft("买这个 meme", feed_item=item)
        self.assertEqual(draft["name"], "新闻驱动 meme 买入")
        token_param = next(p for p in draft["params"] if p["key"] == "token")
        self.assertEqual(token_param["default"], "${entity.token}")

    def test_aave_asset_never_a_meme_token(self):
        item = FeedItem(user_id=USER, title="Solana 生态 meme 币 BONK 交易量创新高",
                        summary="热度持续", entities={"token": "BONK"})
        draft = self.scripts.build_draft("这个能存入吃收益吗", feed_item=item)
        self.assertEqual(draft["name"], "Aave 收益脚本")
        asset_param = next(p for p in draft["params"] if p["key"] == "asset")
        self.assertEqual(asset_param["default"], "USDC")  # 不是 BONK

    def test_explicit_aave_intent_uses_named_asset(self):
        draft = self.scripts.build_draft("把 USDC 存进 Aave 看看收益")
        self.assertEqual(draft["name"], "Aave 收益脚本")
        asset_param = next(p for p in draft["params"] if p["key"] == "asset")
        self.assertEqual(asset_param["default"], "USDC")


class TestBootstrapValidation(unittest.TestCase):
    """必修 6：catalog 启动校验 + model 配置不再静默降级。"""

    def tearDown(self):
        os.environ.pop("MUSE_ME_MODEL", None)

    def test_tampered_catalog_fails_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness_copy = Path(tmp) / "harness"
            shutil.copytree(REPO_ROOT / "harness", harness_copy)
            catalog = harness_copy / "tools" / "catalog.md"
            catalog.write_text(
                catalog.read_text(encoding="utf-8").replace(
                    "dex.sim_swap | write", "dex.sim_swap | read"),
                encoding="utf-8")
            with self.assertRaises(DemoError):
                create_app({"db_path": ":memory:", "start_scheduler": False,
                            "harness_root": str(harness_copy)})

    def test_unknown_model_fails_startup(self):
        with self.assertRaises(DemoError):
            create_app({"db_path": ":memory:", "start_scheduler": False,
                        "model": "gpt-x"})

    def test_openrouter_without_key_fails_startup(self):
        key = os.environ.pop("OPENROUTER_API_KEY", None)
        try:
            with self.assertRaises(DemoError):
                create_app({"db_path": ":memory:", "start_scheduler": False,
                            "model": "openrouter"})
        finally:
            if key is not None:
                os.environ["OPENROUTER_API_KEY"] = key


if __name__ == "__main__":
    unittest.main()
