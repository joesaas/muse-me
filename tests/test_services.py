"""阶段 2–5 服务层与 API 单测：对应评估 4 例行为 + API 冒烟。

零依赖 unittest。运行：python3 -m unittest discover -s tests
"""
import http.cookiejar
import json
import sys
import unittest
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from muse_me.bootstrap import create_app  # noqa: E402
from muse_me.domain import FeedItem  # noqa: E402
from muse_me.errors import GuardrailDenied  # noqa: E402
from muse_me.scheduler import SchedulerDaemon, fmt_iso  # noqa: E402

USER = "demo-user"


def fresh_app():
    return create_app({"db_path": ":memory:", "start_scheduler": False})


class TestScriptBuildSixSteps(unittest.TestCase):
    """评估例 ①：新闻构建脚本命中六步口径。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store

    def tearDown(self):
        self.store.close()

    def test_build_from_news_and_trial(self):
        item = FeedItem(user_id=USER, title="Solana 生态 meme 币 BONK 单日交易量创新高",
                        summary="BONK 流动性池深度一周内翻倍",
                        entities={"token": "BONK", "chain": "solana"})
        draft = self.scripts.build_draft("买这个 meme，100 美元，先查流动性",
                                         feed_item=item)
        steps = list(draft["steps"]) + [draft["final_step"]]
        self.assertEqual([s["tool"] for s in steps],
                         ["meme.scan", "dex.quote", "dex.sim_swap"])
        self.assertEqual(draft["requires_approval_before_step"], 2)
        self.assertEqual(draft["params"][1]["default"], "${entity.token}")
        saved = self.scripts.save_draft(draft)
        trial = self.scripts.trial(saved.id)
        self.assertEqual(trial["status"], "done")
        self.assertEqual([r["tool"] for r in trial["steps"]],
                         ["meme.scan", "dex.quote", "dex.sim_swap"])
        self.assertEqual(trial["facts"]["scan"]["token"], "BONK")
        self.assertEqual(self.store.list_approvals(USER, status="pending"), [])

    def test_formal_run_stops_at_approval_then_resumes(self):
        saved = self.scripts.save_draft(
            self.scripts.build_draft("买 BONK 100 美元"))
        result = self.scripts.run(saved.id)
        self.assertEqual(result["status"], "awaiting_approval")
        pending = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending), 1)
        decided = self.app.services["approvals"].decide(pending[0].id, True)
        self.assertEqual(decided.status.value, "approved")
        run = self.store.get_run(result["run_id"])
        self.assertEqual(run.status.value, "done")
        types = [e.type for e in self.store.list_run_events(run.id)]
        self.assertIn("approval_required", types)
        self.assertEqual(types[-1], "run_done")


class TestGuardrailOverAmount(unittest.TestCase):
    """评估例 ②：超金额被护栏拦。"""

    def setUp(self):
        self.app = fresh_app()
        self.scripts = self.app.services["scripts"]
        self.store = self.app.store

    def tearDown(self):
        self.store.close()

    def test_over_amount_blocked(self):
        saved = self.scripts.save_draft(self.scripts.build_draft("买 BONK"))
        with self.assertRaises(GuardrailDenied):
            self.scripts.run(saved.id, params={"amount_usd": 99999})
        runs = [r for r in self.store.list_runs(USER) if r.script_id == saved.id]
        self.assertTrue(runs)
        self.assertEqual(runs[0].status.value, "failed")
        events = self.store.list_run_events(runs[0].id)
        self.assertEqual(events[-1].type, "run_failed")
        self.assertEqual(events[-1].payload.get("reason"), "guardrail")


class TestMemoryInferenceGate(unittest.TestCase):
    """评估例 ③：推断记忆未批准不生效。"""

    def setUp(self):
        self.app = fresh_app()
        self.memories = self.app.services["memories"]

    def tearDown(self):
        self.app.store.close()

    def test_inference_pending_until_approved(self):
        item = self.memories.add("用户可能偏好高波动 meme 标的", level="inference")
        self.assertEqual(item.status, "pending")
        self.assertNotIn(item.content,
                         [m.content for m in self.memories.active()])
        self.memories.decide(item.id, approved=True)
        self.assertIn(item.content,
                      [m.content for m in self.memories.active()])

    def test_fact_active_immediately_and_never_rejected(self):
        fact = self.memories.add("用户在上海", level="fact")
        self.assertEqual(fact.status, "active")
        with self.assertRaises(GuardrailDenied):
            self.memories.add("不要记这句", level="never")
        unknown = self.memories.add("拿不准的一条")
        self.assertEqual(unknown.level, "inference")
        self.assertEqual(unknown.status, "pending")


class TestJobTimeTriggerApproval(unittest.TestCase):
    """评估例 ④：定时任务 time 触发到点执行且敏感步转审批。"""

    def setUp(self):
        self.app = fresh_app()
        self.store = self.app.store
        self.scripts = self.app.services["scripts"]
        self.jobs = self.app.services["jobs"]

    def tearDown(self):
        self.store.close()

    def _daemon(self) -> SchedulerDaemon:
        return SchedulerDaemon(
            self.store,
            lambda job, params, entity: self.scripts.run(
                job.script_id, params=params, source="job", job_id=job.id,
                entity=entity, version=job.script_version),
            self.app.registry, user_id=USER, retry_backoff=0)

    def test_time_trigger_fires_and_gates(self):
        aave = next(s for s in self.scripts.list() if "Aave" in s.name)
        job = self.jobs.create(name="到点查 Aave", script_id=aave.id,
                               trigger={"type": "time", "every_minutes": 60})
        job.next_fire_at = fmt_iso(datetime.now().astimezone() - timedelta(minutes=1))
        self.store.update_job(job)
        fired = self._daemon().tick()
        self.assertTrue(fired)
        job_runs = self.store.list_job_runs(job.id)
        self.assertEqual(len(job_runs), 1)
        self.assertEqual(job_runs[0].status, "awaiting_approval")
        self.assertEqual(job_runs[0].script_version, aave.current_version)
        pending = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending), 1)
        notes = self.store.list_notifications(USER, unread_only=True)
        self.assertTrue(any("待我确认" in n.body or "确认" in n.title
                            for n in notes))
        # 未到点的 tick 不应重复触发
        self.assertEqual(self._daemon().tick(), [])

    def test_paused_job_does_not_fire(self):
        aave = next(s for s in self.scripts.list() if "Aave" in s.name)
        job = self.jobs.create(name="暂停的任务", script_id=aave.id,
                               trigger={"type": "time", "every_minutes": 60})
        self.jobs.toggle(job.id)
        job.next_fire_at = fmt_iso(datetime.now().astimezone() - timedelta(minutes=1))
        job.enabled = False
        self.store.update_job(job)
        self.assertEqual(self._daemon().tick(), [])


class TestEvaluation(unittest.TestCase):
    def test_run_cases_all_pass_and_gate(self):
        from muse_me.evaluation import gate, run_cases

        report = run_cases()
        self.assertEqual(report["total"], 4, report)
        self.assertEqual(report["failed"], 0, report)
        self.assertTrue(gate(report, report))
        worse = json.loads(json.dumps(report))
        worse["cases"][0]["ok"] = False
        worse["passed"] -= 1
        self.assertFalse(gate(report, worse))


class TestApiSmoke(unittest.TestCase):
    """API 冒烟：ephemeral 端口真 HTTP，字段与 frontend/src/types.ts 抽查对齐。"""

    @classmethod
    def setUpClass(cls):
        cls.app = fresh_app()
        cls.app.start("127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.app.port}"
        cls.jar = http.cookiejar.CookieJar()
        cls.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cls.jar))

    @classmethod
    def tearDownClass(cls):
        cls.app.stop()
        cls.app.store.close()

    def call(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"})
        with self.opener.open(req, timeout=10) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else None

    def test_full_smoke(self):
        status, _ = self.call("POST", "/api/login", {"password": "demo"})
        self.assertEqual(status, 200)

        status, chats = self.call("GET", "/api/chats")
        self.assertEqual(status, 200)
        self.assertTrue(chats)
        for key in ("id", "title", "kind", "updated_at"):
            self.assertIn(key, chats[0])
        chat_id = chats[0]["id"]

        status, sent = self.call("POST", f"/api/chats/{chat_id}/send",
                                 {"text": "看看 ETH"})
        self.assertEqual(status, 200)
        self.assertIn("run_id", sent)

        status, run = self.call("GET", f"/api/runs/{sent['run_id']}")
        self.assertEqual(status, 200)
        for key in ("id", "title", "kind", "status", "cost_usd", "created_at",
                    "events"):
            self.assertIn(key, run)
        self.assertEqual(run["status"], "done")

        status, messages = self.call("GET", f"/api/chats/{chat_id}/messages")
        roles = [m["role"] for m in messages]
        self.assertIn("user", roles)
        self.assertIn("assistant", roles)
        for m in messages:
            for key in ("id", "chat_id", "role", "content"):
                self.assertIn(key, m)

        status, feed = self.call("GET", "/api/feed")
        self.assertEqual(status, 200)
        self.assertTrue(feed)
        for key in ("id", "title", "summary", "entities", "source",
                    "published_at"):
            self.assertIn(key, feed[0])
        self.assertIsInstance(feed[0]["entities"], list)
        if feed[0]["entities"]:
            self.assertIn("value", feed[0]["entities"][0])

        status, scripts = self.call("GET", "/api/scripts")
        self.assertEqual(status, 200)
        self.assertEqual(len(scripts), 2)
        for key in ("id", "name", "description", "version", "params"):
            self.assertIn(key, scripts[0])
        for p in scripts[0]["params"]:
            for key in ("key", "label", "type"):
                self.assertIn(key, p)

        status, approvals = self.call("GET", "/api/approvals")
        self.assertEqual(status, 200)
        self.assertIsInstance(approvals, list)

        status, prompt_doc = self.call("GET", "/api/prompts/feed")
        self.assertIn("content", prompt_doc)
        self.assertIn("version", prompt_doc)

        status, jobs = self.call("GET", "/api/jobs")
        self.assertEqual(status, 200)
        self.assertEqual(len(jobs), 1)
        for key in ("id", "name", "script_id", "trigger", "enabled",
                    "next_run_at", "last_status"):
            self.assertIn(key, jobs[0])
        self.assertEqual(jobs[0]["trigger"]["type"], "time")

        status, connections = self.call("GET", "/api/settings/connections")
        self.assertEqual(status, 200)
        self.assertTrue(connections)
        for key in ("name", "status", "detail"):
            self.assertIn(key, connections[0])
        # 密钥不回明文：任何字段不得出现实际 key 形态
        self.assertNotIn("sk-", json.dumps(connections))

        status, files = self.call("GET", "/api/files")
        self.assertEqual(status, 200)
        self.assertEqual(len(files), 2)
        status_dl, _ = self._download(files[0]["id"])
        self.assertEqual(status_dl, 200)

    def _download(self, file_id: str):
        req = urllib.request.Request(
            f"{self.base}/api/files/{file_id}/download", method="GET")
        with self.opener.open(req, timeout=10) as resp:
            return resp.status, resp.read().decode()

    def test_unauthorized_without_login(self):
        opener = urllib.request.build_opener()
        req = urllib.request.Request(self.base + "/api/chats", method="GET")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            opener.open(req, timeout=10)
        self.assertEqual(cm.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
