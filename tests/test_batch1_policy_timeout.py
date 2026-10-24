"""批次一（口径与正确性）单测：护栏单真值源、审批超时、published_at 不编造。

零依赖 unittest。运行：python3 -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from muse_me.domain import FeedItem  # noqa: E402
from muse_me.errors import ApprovalExpired  # noqa: E402
from muse_me.feed import FeedGenerator, SeedNews  # noqa: E402
from muse_me.harness_files import HarnessFiles, _fail_closed_policy  # noqa: E402
from muse_me.scheduler import SchedulerDaemon  # noqa: E402
from muse_me.storage import SqliteStore  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from muse_me.bootstrap import create_app  # noqa: E402

USER = "demo-user"
REPO_ROOT = Path(__file__).resolve().parents[1]


def fresh_app():
    return create_app({"db_path": ":memory:", "start_scheduler": False})


def _backdate_approval(store, approval_id, minutes):
    old = (datetime.now().astimezone() - timedelta(minutes=minutes)).strftime(
        "%Y-%m-%dT%H:%M:%S%z")
    store._exec("UPDATE approvals SET created_at=? WHERE id=?",
                (old, approval_id))


class TestPolicySingleSource(unittest.TestCase):
    """仓库真实 policy.md 解析值与 fail-closed 语义。"""

    def test_real_policy_file_values(self):
        policy = HarnessFiles(REPO_ROOT / "harness").load_guardrails()
        self.assertEqual(policy.max_cost_per_run_usd, 1.0)
        self.assertEqual(policy.max_cost_per_day_usd, 10.0)
        self.assertEqual(policy.max_sim_amount_usd, 1000.0)
        self.assertEqual(policy.approval_timeout_minutes, 60)
        self.assertEqual(policy.risk_levels["read"], "auto")
        self.assertEqual(policy.risk_levels["write"], "batch_approval")
        self.assertEqual(policy.risk_levels["irreversible"], "single_approval")

    def _write_policy(self, body):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "guardrails").mkdir()
        (tmp / "guardrails" / "policy.md").write_text(
            "# 护栏\n```policy\n" + body + "```\n", encoding="utf-8")
        return HarnessFiles(tmp)

    def test_missing_key_fails_closed(self):
        # 缺 approval_timeout_minutes → 不回落默认值，限额归零、全单独审批。
        hf = self._write_policy(
            "max_cost_per_run_usd: 1.00\n"
            "max_cost_per_day_usd: 10.00\n"
            "max_sim_amount_usd: 1000\n"
            "risk_levels:\n"
            "  read: auto\n  write: batch_approval\n"
            "  irreversible: single_approval\n")
        policy = hf.load_guardrails()
        self.assertEqual(policy.max_cost_per_run_usd, 0.0)
        self.assertEqual(policy.max_cost_per_day_usd, 0.0)
        self.assertEqual(policy.max_sim_amount_usd, 0.0)
        self.assertEqual(policy.risk_levels["read"], "single_approval")
        self.assertEqual(policy.approval_default, "deny")

    def test_missing_risk_level_fails_closed(self):
        hf = self._write_policy(
            "max_cost_per_run_usd: 1.00\n"
            "max_cost_per_day_usd: 10.00\n"
            "max_sim_amount_usd: 1000\n"
            "approval_timeout_minutes: 60\n"
            "risk_levels:\n  read: auto\n  write: batch_approval\n")
        self.assertEqual(hf.load_guardrails().max_cost_per_run_usd, 0.0)

    def test_illegal_risk_action_fails_closed(self):
        hf = self._write_policy(
            "max_cost_per_run_usd: 1.00\n"
            "max_cost_per_day_usd: 10.00\n"
            "max_sim_amount_usd: 1000\n"
            "approval_timeout_minutes: 60\n"
            "risk_levels:\n  read: whatever\n  write: batch_approval\n"
            "  irreversible: single_approval\n")
        self.assertEqual(hf.load_guardrails().max_cost_per_run_usd, 0.0)

    def test_missing_file_fails_closed(self):
        policy = HarnessFiles(Path(tempfile.mkdtemp())).load_guardrails()
        self.assertEqual(policy, _fail_closed_policy())
        self.assertEqual(policy.risk_levels["read"], "single_approval")


class TestApprovalTimeout(unittest.TestCase):
    """审批超时：decide 得 ApprovalExpired、审批 rejected、run failed；tick 清扫。"""

    def setUp(self):
        self.app = fresh_app()
        self.store = self.app.store
        self.approvals = self.app.services["approvals"]
        self.scripts = self.app.services["scripts"]

    def tearDown(self):
        self.store.close()

    def _pending_run(self):
        saved = self.scripts.save_draft(
            self.scripts.build_draft("买 BONK 100 美元"))
        result = self.scripts.run(saved.id)
        self.assertEqual(result["status"], "awaiting_approval")
        pending = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending), 1)
        return result, pending[0]

    def test_decide_expired_raises_and_fails_run(self):
        result, approval = self._pending_run()
        _backdate_approval(self.store, approval.id, minutes=61)
        with self.assertRaises(ApprovalExpired) as ctx:
            self.approvals.decide(approval.id, True)
        self.assertIn("审批已过期", str(ctx.exception))
        after = self.store.get_approval(approval.id)
        self.assertEqual(after.status.value, "rejected")
        self.assertEqual(after.reason, "approval_timeout")
        run = self.store.get_run(result["run_id"])
        self.assertEqual(run.status.value, "failed")

    def test_decide_within_timeout_still_works(self):
        result, approval = self._pending_run()
        _backdate_approval(self.store, approval.id, minutes=30)
        decided = self.approvals.decide(approval.id, True)
        self.assertEqual(decided.status.value, "approved")

    def test_tick_sweeps_expired(self):
        result, approval = self._pending_run()
        _backdate_approval(self.store, approval.id, minutes=120)
        daemon = SchedulerDaemon(
            self.store, lambda *a, **k: {}, None, user_id=USER,
            approval_sweeper=self.approvals.expire_stale)
        daemon.tick()
        after = self.store.get_approval(approval.id)
        self.assertEqual(after.status.value, "rejected")
        run = self.store.get_run(result["run_id"])
        self.assertEqual(run.status.value, "failed")


class TestPublishedAtNotFabricated(unittest.TestCase):
    """池内无时间 → published_at 为 None，不拼 BASE_DATE+序号。"""

    def test_no_time_is_none(self):
        store = SqliteStore(":memory:")
        try:
            gen = FeedGenerator(store, SeedNews([{
                "title": "无时间新闻", "summary": "摘要",
                "source": "SeedNews", "topic": "meme",
                "entities": {"token": "BONK"},
            }]))
            items = gen.generate(USER, "BONK")
            self.assertEqual(len(items), 1)
            self.assertIsNone(items[0].published_at)
        finally:
            store.close()

    def test_real_time_preserved(self):
        store = SqliteStore(":memory:")
        try:
            gen = FeedGenerator(store, SeedNews([{
                "title": "有时间新闻", "summary": "摘要",
                "source": "SeedNews", "topic": "meme",
                "entities": {"token": "BONK"},
                "published_at": "2026-10-24T10:00:00+0800",
            }]))
            items = gen.generate(USER, "BONK")
            self.assertEqual(items[0].published_at, "2026-10-24T10:00:00+0800")
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
