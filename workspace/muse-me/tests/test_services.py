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
from muse_me.errors import (  # noqa: E402
    GuardrailDenied,
    InvalidTransition,
    ValidationFailed,
)
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


class TestChatResumeNoDuplicates(unittest.TestCase):
    """聊天审批续跑：已完成步不重跑、不重复计费、轨迹不出现第二遍。

    回归评审 services P1（续跑整 plan 重演）。用计数包装包住 registry.call
    数真实工具调用次数；金额/风险断言兼覆盖 _create_chat_approval 改从
    事件推导（不再重演 model.plan 猜金额、risk 不写死）。
    """

    def setUp(self):
        self.app = fresh_app()
        self.store = self.app.store
        self.chats = self.app.services["chats"]
        self.approvals = self.app.services["approvals"]
        from collections import Counter

        self.tool_calls: Counter = Counter()
        orig_call = self.app.registry.call

        def counting(name, args=None, mode="simulate"):
            self.tool_calls[name] += 1
            return orig_call(name, args, mode)

        self.app.registry.call = counting

    def tearDown(self):
        self.store.close()

    def test_resume_does_not_rerun_completed_steps(self):
        item = self.app.services["feed"].list()[0]
        chat = self.chats.create_chat(kind="side", feed_item_id=item.id,
                                      title="构建脚本", scene="script_build")
        result = self.chats.send(chat.id, "买这个 meme，100 美元，先查流动性")
        run_id = result["run_id"]
        run = self.store.get_run(run_id)
        self.assertEqual(run.status.value, "awaiting_approval")
        cost_before = run.cost_usd
        calls_before = dict(self.tool_calls)

        pending = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending), 1)
        approval = pending[0]
        # 金额从本 run 已落库事件推导（报价步 args），risk 按工具查注册表
        self.assertEqual(approval.amount_usd, 100.0)
        self.assertEqual(approval.risk,
                         self.app.registry.get_tool("dex.sim_swap").risk)
        self.assertEqual(approval.step_index, 2)

        self.approvals.decide(approval.id, True)
        run = self.store.get_run(run_id)
        self.assertEqual(run.status.value, "done")

        events = self.store.list_run_events(run_id)
        from collections import Counter

        called_steps = Counter((e.payload or {}).get("step")
                               for e in events if e.type == "tool_called")
        done_steps = Counter((e.payload or {}).get("step")
                             for e in events if e.type == "step_done")
        self.assertEqual(called_steps, {"0": 1, "1": 1, "2": 1})
        self.assertEqual(done_steps, {"0": 1, "1": 1, "2": 1})
        # 真实工具调用：已完成的 scan/quote 各只调一次，续跑只新增 sim_swap
        self.assertEqual(self.tool_calls["meme.scan"],
                         calls_before.get("meme.scan", 0))
        self.assertEqual(self.tool_calls["dex.quote"],
                         calls_before.get("dex.quote", 0))
        self.assertEqual(self.tool_calls["dex.sim_swap"],
                         calls_before.get("dex.sim_swap", 0) + 1)
        # run 总成本 == 各步 step_done 成本之和（无重复累计）
        total_step_cost = sum(float((e.payload or {}).get("cost_usd") or 0)
                              for e in events if e.type == "step_done")
        self.assertAlmostEqual(run.cost_usd, total_step_cost, places=9)
        self.assertGreater(run.cost_usd, cost_before)


class TestMemoryDecidePrecondition(unittest.TestCase):
    """MemoryService.decide 前置：非 pending 记忆不可再裁决（评审 P1）。"""

    def setUp(self):
        self.app = fresh_app()
        self.memories = self.app.services["memories"]

    def tearDown(self):
        self.app.store.close()

    def test_decide_active_memory_raises_and_keeps_status(self):
        fact = self.memories.add("用户在上海", level="fact")
        self.assertEqual(fact.status, "active")
        with self.assertRaises(InvalidTransition):
            self.memories.decide(fact.id, approved=False)
        fresh = self.app.store.get_memory(fact.id)
        self.assertEqual(fresh.status, "active")

    def test_decide_twice_raises(self):
        item = self.memories.add("一条推断", level="inference")
        self.memories.decide(item.id, approved=True)
        with self.assertRaises(InvalidTransition):
            self.memories.decide(item.id, approved=False)
        self.assertEqual(self.app.store.get_memory(item.id).status, "active")


class TestJobCreateValidation(unittest.TestCase):
    """JobService.create 接入 validate_trigger：非法规格不落库（评审 P2）。"""

    def setUp(self):
        self.app = fresh_app()
        self.store = self.app.store
        self.jobs = self.app.services["jobs"]
        self.script = self.app.services["scripts"].list()[0]

    def tearDown(self):
        self.store.close()

    def test_negative_every_minutes_rejected(self):
        before = len(self.jobs.list())
        with self.assertRaises(ValidationFailed):
            self.jobs.create(name="坏任务", script_id=self.script.id,
                             trigger={"type": "time", "every_minutes": -5})
        self.assertEqual(len(self.jobs.list()), before)

    def test_illegal_cron_daily_rejected(self):
        before = len(self.jobs.list())
        with self.assertRaises(ValidationFailed):
            self.jobs.create(name="坏任务2", script_id=self.script.id,
                             trigger={"type": "time", "cron_daily": "25:99"})
        self.assertEqual(len(self.jobs.list()), before)

    def test_valid_trigger_still_creates(self):
        job = self.jobs.create(name="好任务", script_id=self.script.id,
                               trigger={"type": "time", "every_minutes": 30})
        self.assertTrue(job.id)


class TestMainPasswordGuard(unittest.TestCase):
    """__main__ 口令守卫：非本机绑定 + 默认口令拒绝启动。"""

    def test_remote_host_default_password_rejected(self):
        from muse_me.__main__ import guard_remote_default_password

        with self.assertRaises(SystemExit):
            guard_remote_default_password("0.0.0.0", "demo")

    def test_local_or_custom_password_allowed(self):
        from muse_me.__main__ import guard_remote_default_password

        guard_remote_default_password("127.0.0.1", "demo")
        guard_remote_default_password("localhost", "demo")
        guard_remote_default_password("0.0.0.0", "custom-secret")


class TestEvaluation(unittest.TestCase):
    def test_run_cases_all_pass_and_gate(self):
        from muse_me.evaluation import gate, run_cases

        report = run_cases()
        # 用例集只增不减（已从 4 例扩到 7 例）：总数与实跑例数对齐即可，
        # 不写死具体数字，真正的门是 failed == 0。
        self.assertEqual(report["total"], len(report["cases"]), report)
        self.assertGreaterEqual(report["total"], 4, report)
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

    def call_raw(self, method: str, path: str, body: dict | None = None):
        """不抛异常版：返回 (status, raw_text)。"""
        import urllib.error

        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=10) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode()

    def test_decide_rejects_non_bool_approved(self):
        """decide 接口 approved 必须为 JSON 布尔：字符串 "false" → 400
        且不发生任何裁决（回归 api.py bool() 强转把拒绝变批准）。"""
        status, _ = self.call("POST", "/api/login", {"password": "demo"})
        self.assertEqual(status, 200)

        # memories decide
        item = self.app.services["memories"].add("待裁决的推断", level="inference")
        status, _raw = self.call_raw(
            "POST", f"/api/memories/{item.id}/decide", {"approved": "false"})
        self.assertEqual(status, 400)
        self.assertEqual(self.app.store.get_memory(item.id).status, "pending")
        status, body = self.call(
            "POST", f"/api/memories/{item.id}/decide", {"approved": False})
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "rejected")

        # DELETE 204 不带 body
        status, raw = self.call_raw("DELETE", f"/api/memories/{item.id}")
        self.assertEqual(status, 204)
        self.assertEqual(raw, "")

        # approvals decide
        scripts = self.app.services["scripts"]
        saved = scripts.save_draft(scripts.build_draft("买 BONK 100 美元"))
        result = scripts.run(saved.id)
        self.assertEqual(result["status"], "awaiting_approval")
        pending = self.app.store.list_approvals(USER, status="pending")
        self.assertTrue(pending)
        target = pending[0]
        status, _raw = self.call_raw(
            "POST", f"/api/approvals/{target.id}/decide", {"approved": "false"})
        self.assertEqual(status, 400)
        fresh = self.app.store.get_approval(target.id)
        self.assertEqual(fresh.status.value, "pending")

    def test_unauthorized_without_login(self):
        opener = urllib.request.build_opener()
        req = urllib.request.Request(self.base + "/api/chats", method="GET")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            opener.open(req, timeout=10)
        self.assertEqual(cm.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
