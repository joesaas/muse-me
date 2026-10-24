"""阶段 1 后端核心层单测（T1.1–T1.5）：storage / harness / tools / execution / runtime。

零依赖 unittest。运行：python3 -m unittest discover -s tests -v
仓库根需在 sys.path（discover 在仓库根执行时 src 布局由此文件补路径）。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from muse_me import tools as tools_mod  # noqa: E402
from muse_me.domain import (  # noqa: E402
    Approval,
    Chat,
    FeedItem,
    GuardrailPolicy,
    Job,
    JobRun,
    MemoryItem,
    Message,
    Notification,
    Run,
    RunStatus,
    Script,
    validate_transition,
)
from muse_me.errors import (  # noqa: E402
    DemoError,
    GuardrailDenied,
    InvalidTransition,
    RuntimeNotConfigured,
)
from muse_me.execution import (  # noqa: E402
    FactBoard,
    Orchestrator,
    Plan,
    delegate_step,
    parallel_step,
    reflect_step,
    route_step,
    sequence_step,
    tool_step,
)
from muse_me.harness_files import HarnessFiles  # noqa: E402
from muse_me.llm import MockModel, OpenRouterModel  # noqa: E402
from muse_me.runtime import AgentCoreRuntime, LocalRuntime  # noqa: E402
from muse_me.storage import SqliteStore  # noqa: E402
from muse_me.tools import ToolRegistry, validate_catalog  # noqa: E402

HARNESS_ROOT = Path(__file__).resolve().parents[1] / "harness"
USER = "u1"


class TestStorage(unittest.TestCase):
    def setUp(self):
        self.store = SqliteStore(":memory:")

    def tearDown(self):
        self.store.close()

    def test_chat_and_messages_crud(self):
        chat = self.store.create_chat(Chat(user_id=USER, title="主聊"))
        self.assertEqual(self.store.get_chat(chat.id).title, "主聊")
        self.assertEqual(len(self.store.list_chats(USER)), 1)
        self.store.add_message(Message(chat_id=chat.id, role="user", content="你好"))
        self.store.add_message(Message(chat_id=chat.id, role="assistant", content="在"))
        msgs = self.store.list_messages(chat.id)
        self.assertEqual([m.content for m in msgs], ["你好", "在"])

    def test_run_and_events_crud(self):
        run = self.store.create_run(Run(user_id=USER, scene="chat"))
        from muse_me.domain import RunEvent

        self.store.add_run_event(RunEvent(run_id=run.id, type="plan_created"))
        self.store.add_run_event(RunEvent(run_id=run.id, type="run_done"))
        events = self.store.list_run_events(run.id)
        self.assertEqual([e.type for e in events], ["plan_created", "run_done"])
        self.assertEqual([e.seq for e in events], [1, 2])
        self.store.add_run_cost(run.id, 0.25, tokens=10)
        self.assertAlmostEqual(self.store.get_run(run.id).cost_usd, 0.25)

    def test_approval_decide_once(self):
        run = self.store.create_run(Run(user_id=USER))
        ap = self.store.create_approval(
            Approval(run_id=run.id, step_index=2, action="dex.sim_swap", risk="write")
        )
        pending = self.store.list_approvals(USER, status="pending")
        self.assertEqual(len(pending), 1)
        decided = self.store.decide_approval(ap.id, "approved")
        self.assertEqual(decided.status.value, "approved")
        with self.assertRaises(DemoError):
            self.store.decide_approval(ap.id, "denied")

    def test_memory_decide_and_delete(self):
        item = self.store.add_memory(
            MemoryItem(user_id=USER, content="喜欢简洁回复", level="inference",
                       status="pending")
        )
        self.store.decide_memory(item.id, approved=True)
        self.assertEqual(self.store.get_memory(item.id).status, "active")
        self.assertTrue(self.store.delete_memory(item.id))
        self.assertIsNone(self.store.get_memory(item.id))

    def test_script_versions_increment(self):
        script = self.store.create_script(
            Script(user_id=USER, name="脚本A", doc={"steps": []})
        )
        self.assertEqual(len(self.store.list_script_versions(script.id)), 1)
        script.doc = {"steps": [{"tool": "market.quote"}]}
        self.store.update_script(script)
        versions = self.store.list_script_versions(script.id)
        self.assertEqual([v.version for v in versions], [1, 2])
        self.assertEqual(self.store.get_script(script.id).current_version, 2)
        self.assertEqual(
            self.store.get_script_version(script.id, 1).doc, {"steps": []}
        )

    def test_job_and_job_run_crud(self):
        job = self.store.create_job(
            Job(user_id=USER, name="每日查价", script_id="s1",
                trigger_type="time", trigger_spec={"daily": "09:00"})
        )
        self.store.add_job_run(JobRun(job_id=job.id, status="done", script_version=1))
        self.assertEqual(len(self.store.list_jobs(USER)), 1)
        runs = self.store.list_job_runs(job.id)
        self.assertEqual(runs[0].status, "done")
        job.enabled = False
        self.store.update_job(job)
        self.assertFalse(self.store.get_job(job.id).enabled)

    def test_feed_and_prompts_and_misc(self):
        self.store.add_feed_item(FeedItem(user_id=USER, title="新闻一"))
        self.assertEqual(len(self.store.list_feed_items(USER)), 1)
        p1 = self.store.set_prompt(USER, "feed", "只看 DeFi")
        p2 = self.store.set_prompt(USER, "feed", "只看 DeFi 和 meme")
        self.assertEqual((p1.version, p2.version), (1, 2))
        self.assertEqual(self.store.get_prompt(USER, "feed").content, "只看 DeFi 和 meme")
        self.assertEqual(len(self.store.list_prompt_versions(USER, "feed")), 2)

    def test_notifications_secrets_files(self):
        self.store.add_notification(Notification(user_id=USER, title="提醒"))
        notes = self.store.list_notifications(USER, unread_only=True)
        self.assertEqual(len(notes), 1)
        self.assertTrue(self.store.mark_notification_read(notes[0].id))
        self.assertEqual(self.store.list_notifications(USER, unread_only=True), [])
        self.store.set_secret_ref(USER, "openrouter", "vault://openrouter")
        self.assertEqual(self.store.get_secret_ref(USER, "openrouter"), "vault://openrouter")
        self.assertEqual([s["name"] for s in self.store.list_secrets_ref(USER)],
                         ["openrouter"])
        self.store.add_file(USER, "报告.html", "report", "files/1", size=10)
        self.assertEqual(len(self.store.list_files(USER)), 1)


class TestRunStateMachine(unittest.TestCase):
    def test_legal_and_illegal_transitions(self):
        self.assertTrue(validate_transition("running", "awaiting_approval") is None)
        run = Run(user_id=USER)
        run.transition_to(RunStatus.AWAITING_APPROVAL)
        run.transition_to(RunStatus.RUNNING)
        run.transition_to(RunStatus.DONE)
        with self.assertRaises(InvalidTransition):
            run.transition_to(RunStatus.RUNNING)  # 终态不可再迁移
        with self.assertRaises(InvalidTransition):
            validate_transition("done", "running")
        with self.assertRaises(InvalidTransition):
            validate_transition("awaiting_approval", "done")  # 必须先回 running

    def test_store_rejects_illegal_transition(self):
        store = SqliteStore(":memory:")
        run = store.create_run(Run(user_id=USER))
        store.update_run_status(run.id, "done")
        with self.assertRaises(InvalidTransition):
            store.update_run_status(run.id, "running")
        store.close()


class TestHarnessFiles(unittest.TestCase):
    def setUp(self):
        self.harness = HarnessFiles(HARNESS_ROOT)

    def test_guardrails_parsed(self):
        policy = self.harness.load_guardrails()
        self.assertEqual(policy.max_cost_per_run_usd, 1.00)
        self.assertEqual(policy.max_cost_per_day_usd, 10.00)
        self.assertEqual(policy.max_sim_amount_usd, 1000.0)
        self.assertEqual(policy.approval_timeout_minutes, 60)
        self.assertEqual(policy.approval_default, "deny")
        self.assertEqual(policy.action_for_risk("read"), "auto")
        self.assertEqual(policy.action_for_risk("write"), "batch_approval")
        self.assertEqual(policy.action_for_risk("irreversible"), "single_approval")

    def test_guardrails_missing_file_fails_closed(self):
        policy = HarnessFiles(HARNESS_ROOT / "nope").load_guardrails()
        self.assertEqual(policy.approval_default, "deny")
        self.assertEqual(policy.max_sim_amount_usd, 0.0)

    def test_version_includes_playbooks(self):
        import shutil
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            dst = Path(td) / "harness"
            shutil.copytree(HARNESS_ROOT, dst)
            h = HarnessFiles(dst)
            v1 = h.harness_version()
            self.assertTrue(v1.startswith("h-"))
            (dst / "playbooks" / "script-building.md").write_text(
                (dst / "playbooks" / "script-building.md").read_text(encoding="utf-8")
                + "\n改动\n",
                encoding="utf-8",
            )
            self.assertNotEqual(v1, h.harness_version())  # 改手册必变版本

    def test_assemble_context_order(self):
        ctx = self.harness.assemble_context("script_build")
        self.assertIn("决策原则", ctx)
        self.assertIn("脚本构建手册", ctx)
        self.assertIn("原子工具目录", ctx)
        self.assertLess(ctx.index("决策原则"), ctx.index("脚本构建手册"))  # 原则在前


class TestTools(unittest.TestCase):
    def setUp(self):
        self.registry = ToolRegistry()

    def test_registry_has_nine_tools_with_risks(self):
        tools = {t["name"]: t["risk"] for t in self.registry.list_tools()}
        self.assertEqual(len(tools), 9)
        self.assertEqual(tools["dex.sim_swap"], "write")
        self.assertEqual(tools["market.quote"], "read")

    def test_deterministic_prices(self):
        a = self.registry.call("market.quote", {"symbol": "ETH"})
        b = self.registry.call("market.quote", {"symbol": "eth"})
        self.assertEqual(a, b)
        self.assertEqual(a["price_usd"], 3420.0)
        x = self.registry.call("market.quote", {"symbol": "ZZZUNKNOWN"})
        y = self.registry.call("market.quote", {"symbol": "ZZZUNKNOWN"})
        self.assertEqual(x["price_usd"], y["price_usd"])  # 哈希伪价格稳定

    def test_meme_scan_any_token(self):
        scan = self.registry.call("meme.scan", {"token": "BONK"})
        self.assertEqual(scan["token"], "BONK")
        self.assertIn(scan["risk_level"], ("low", "medium", "high"))
        self.assertGreater(scan["liquidity_usd"], 0)
        from_text = self.registry.call("meme.scan", {"text": "快看 PEPE 异动"})
        self.assertEqual(from_text["token"], "PEPE")

    def test_dex_and_aave_simulate(self):
        quote = self.registry.call("dex.quote", {"token": "SOL", "amount_usd": 100})
        self.assertGreater(quote["est_received"], 0)
        swap = self.registry.call("dex.sim_swap", {"token": "SOL", "amount_usd": 100})
        self.assertEqual(swap["status"], "simulated")
        rates = self.registry.call("aave.rates", {"asset": "USDC"})
        self.assertEqual(rates["supply_apy"], 4.62)
        supply = self.registry.call(
            "aave.sim_supply", {"asset": "USDC", "amount_usd": 1000, "days": 365}
        )
        self.assertAlmostEqual(supply["est_earnings_usd"], 46.2)
        with self.assertRaises(GuardrailDenied):
            self.registry.call("dex.sim_swap", {"token": "SOL", "amount_usd": 1},
                               mode="live")

    def test_news_search_default_pool_and_injection(self):
        hits = self.registry.call("news.search", {"query": "meme"})
        self.assertGreaterEqual(hits["count"], 1)
        custom = ToolRegistry(news_pool=[{"title": "独家新闻 XYZ", "summary": "",
                                          "topic": "t", "entities": {}}])
        self.assertEqual(
            custom.call("news.search", {"query": "XYZ"})["count"], 1
        )

    def test_web_fetch_stub_and_notify_local(self):
        fetched = self.registry.call("web.fetch", {"url": "https://example.com"})
        self.assertEqual(fetched["status"], "stub")
        sent = self.registry.call("notify.send", {"title": "hi", "body": "b"})
        self.assertEqual(sent["delivered"], "local")
        self.assertEqual(len(self.registry.outbox), 1)

    def test_unknown_tool_rejected(self):
        with self.assertRaises(DemoError):
            self.registry.call("shell.exec", {})

    def test_catalog_validation(self):
        text = (HARNESS_ROOT / "tools" / "catalog.md").read_text(encoding="utf-8")
        self.assertTrue(validate_catalog(text))
        self.assertTrue(tools_mod.validate_catalog(text))
        self.assertFalse(validate_catalog("- market.quote | write | 改风险\n"))


def _types(events):
    return [e.type for e in events]


class TestExecution(unittest.TestCase):
    def setUp(self):
        self.registry = ToolRegistry()
        self.orch = Orchestrator(tool_call=self.registry.call)

    def test_tool_step_and_facts(self):
        plan = Plan(goal="查价", steps=[
            tool_step("market.quote", {"symbol": "SOL"}, save_as="q"),
        ])
        events = list(self.orch.run_plan(plan, {"run_id": "r1"}))
        self.assertEqual(_types(events)[0], "plan_created")
        self.assertEqual(_types(events)[-1], "run_done")
        self.assertIn("tool_called", _types(events))
        self.assertEqual(self.orch.board.read("q")["price_usd"], 214.5)

    def test_sequence_primitive(self):
        plan = Plan(steps=[sequence_step([
            tool_step("market.quote", {"symbol": "ETH"}, save_as="a"),
            tool_step("aave.rates", {"asset": "USDC"}, save_as="b"),
        ])])
        events = list(self.orch.run_plan(plan, {}))
        self.assertEqual(_types(events)[-1], "run_done")
        self.assertIsNotNone(self.orch.board.read("a"))
        self.assertIsNotNone(self.orch.board.read("b"))

    def test_route_primitive(self):
        calls = {"n": 0}

        def caller(name, args):
            calls["n"] += 1
            return {"which": "risky" if calls["n"] == 1 else "safe", "cost_usd": 0.0}

        orch = Orchestrator(tool_call=caller)
        plan = Plan(steps=[
            tool_step("probe", {}, save_as="probe"),
            route_step("probe.which", {
                "risky": tool_step("probe", {}, save_as="branch_risky"),
                "default": tool_step("probe", {}, save_as="branch_safe"),
            }),
        ])
        # route 读的是事实值本身；probe.which 经 save_as 存整结果，需用 ${} 不在此测
        events = list(orch.run_plan(plan, {"facts": {"probe.which": "x"}}))
        self.assertIn("run_done", _types(events))  # default 分支可达即可

    def test_route_by_fact_value(self):
        orch = Orchestrator(tool_call=lambda n, a: {"ok": n, "cost_usd": 0.0})
        plan = Plan(steps=[
            route_step("mode", {
                "fast": tool_step("t.fast", {}, save_as="picked"),
                "default": tool_step("t.slow", {}, save_as="picked"),
            }),
        ])
        events = list(orch.run_plan(plan, {"facts": {"mode": "fast"}}))
        self.assertEqual(_types(events)[-1], "run_done")
        self.assertEqual(orch.board.read("picked")["ok"], "t.fast")

    def test_parallel_isolates_failure(self):
        def caller(name, args):
            if name == "bad.tool":
                raise RuntimeError("boom")
            return {"ok": name, "cost_usd": 0.0}

        orch = Orchestrator(tool_call=caller)
        plan = Plan(steps=[parallel_step([
            tool_step("good.a", {}, save_as="ga"),
            tool_step("bad.tool", {}, save_as="gb"),
            tool_step("good.b", {}, save_as="gc"),
        ])])
        events = list(orch.run_plan(plan, {}))
        self.assertEqual(_types(events)[-1], "run_done")  # 失败被隔离
        self.assertIn("step_failed", _types(events))
        self.assertIsNotNone(orch.board.read("ga"))
        self.assertIsNotNone(orch.board.read("gc"))

    def test_reflect_retries_then_passes(self):
        state = {"n": 0}

        def caller(name, args):
            state["n"] += 1
            if state["n"] >= 2:
                return {"ready": True, "cost_usd": 0.0}
            return {}  # 空结果存入事实板为 falsy，触发打回

        orch = Orchestrator(tool_call=caller)
        plan = Plan(steps=[
            reflect_step(tool_step("flaky", {}, save_as="ready_flag"),
                         checks=["ready_flag"], max_retries=2),
        ])
        events = list(orch.run_plan(plan, {}))
        self.assertIn("reflect_failed", _types(events))  # 第一轮被打回
        self.assertEqual(_types(events)[-1], "run_done")  # 第二轮通过
        self.assertEqual(state["n"], 2)

    def test_reflect_passes_when_check_satisfied(self):
        board_ready = {"attempt": 0}

        def caller(name, args):
            board_ready["attempt"] += 1
            return {"cost_usd": 0.0, "value": 1}

        orch = Orchestrator(tool_call=caller)
        step = reflect_step(tool_step("noop", {}, save_as="done_flag"),
                            checks=["done_flag"], max_retries=1)
        events = list(orch.run_plan(Plan(steps=[step]), {}))
        self.assertEqual(_types(events)[-1], "run_done")
        self.assertNotIn("reflect_failed", _types(events))

    def test_delegate_isolation_and_depth(self):
        orch = Orchestrator(tool_call=lambda n, a: {"v": n, "cost_usd": 0.0})
        sub = Plan(goal="子任务", steps=[tool_step("inner", {}, save_as="inner_fact")])
        plan = Plan(steps=[delegate_step(sub, save_as="child")])
        events = list(orch.run_plan(plan, {}))
        self.assertEqual(_types(events)[-1], "run_done")
        self.assertIn("inner_fact", orch.board.read("child"))  # 子板快照回主板
        self.assertIsNone(orch.board.read("inner_fact"))  # 隔离：不直写主板

        deep = Plan(steps=[delegate_step(Plan(steps=[delegate_step(
            Plan(steps=[delegate_step(Plan(steps=[]))]))]))])
        events = list(orch.run_plan(deep, {}))
        self.assertEqual(_types(events)[-1], "run_failed")  # 深度 >2 被拦

    def test_approval_suspend_and_resume(self):
        orch = Orchestrator(tool_call=lambda n, a: {"ok": n, "cost_usd": 0.0})
        plan = Plan(steps=[
            tool_step("a.read", {}, save_as="a"),
            tool_step("b.write", {}, save_as="b", needs_approval=True),
        ])
        events = list(orch.run_plan(plan, {"run_id": "ra"}))
        self.assertEqual(_types(events)[-1], "approval_required")
        self.assertIsNone(orch.board.read("b"))
        events2 = list(orch.run_plan(plan, {"run_id": "ra"},
                                     resume_from={"approved": ["1"]}))
        self.assertEqual(_types(events2)[-1], "run_done")
        events3 = list(orch.run_plan(plan, {"run_id": "ra"}, resume_from=1))
        self.assertEqual(_types(events3)[-1], "run_done")

    def test_budget_hard_stop(self):
        policy = GuardrailPolicy(max_cost_per_run_usd=0.0025)
        orch = Orchestrator(tool_call=self.registry.call, policy=policy)
        plan = Plan(steps=[
            tool_step("meme.scan", {"token": "BONK"}),      # 0.002
            tool_step("dex.quote", {"token": "BONK", "amount_usd": 10}),  # +0.002 超顶
            tool_step("market.quote", {"symbol": "ETH"}),
        ])
        events = list(orch.run_plan(plan, {}))
        self.assertEqual(_types(events)[-1], "run_failed")
        failed = events[-1]
        self.assertEqual(failed.payload["reason"], "budget")

    def test_fact_board_single_writer(self):
        board = FactBoard(owner="orchestrator")
        board.write("k", 1)
        with self.assertRaises(DemoError):
            board.write("k", 2, writer="intruder")
        snap = board.snapshot()
        snap["k"] = 99
        self.assertEqual(board.read("k"), 1)  # 快照是深拷贝


class TestLLM(unittest.TestCase):
    def test_mock_deterministic(self):
        mock = MockModel()
        msgs = [{"role": "user", "content": "帮我看看 SOL"}]
        self.assertEqual(mock.complete(msgs), mock.complete(msgs))
        plan = mock.plan("script_build", "买 BONK 200 美元")
        tools_used = [s.tool for s in plan.steps]
        self.assertEqual(tools_used, ["meme.scan", "dex.quote", "dex.sim_swap"])
        self.assertTrue(plan.steps[-1].needs_approval)
        self.assertEqual(plan.steps[1].args["amount_usd"], 200.0)

    def test_openrouter_missing_key_raises_with_guidance(self):
        model = OpenRouterModel(api_key="")
        import os

        if not os.environ.get("OPENROUTER_API_KEY"):
            with self.assertRaises(DemoError) as cm:
                model.complete([{"role": "user", "content": "hi"}])
            self.assertIn("OPENROUTER_API_KEY", str(cm.exception))


class TestRuntime(unittest.TestCase):
    def test_local_runtime_end_to_end_with_store(self):
        store = SqliteStore(":memory:")
        runtime = LocalRuntime(model=MockModel(), store=store,
                               tool_call=ToolRegistry().call)
        session = runtime.create_session(USER, "chat")
        events = list(runtime.invoke(session.id, "看看 ETH", {}))
        self.assertEqual(events[-1].type, "run_done")
        trace = runtime.get_trace(events[0].run_id)
        self.assertEqual([e.type for e in trace], [e.type for e in events])
        run = store.get_run(events[0].run_id)
        self.assertEqual(run.status, RunStatus.DONE)
        self.assertEqual(runtime.health()["status"], "ok")
        store.close()

    def test_local_runtime_approval_suspends_run(self):
        store = SqliteStore(":memory:")
        runtime = LocalRuntime(model=MockModel(), store=store,
                               tool_call=ToolRegistry().call)
        session = runtime.create_session(USER, "script_build")
        events = list(runtime.invoke(session.id, "买 BONK 100 美元", {}))
        self.assertEqual(events[-1].type, "approval_required")
        run = store.get_run(events[0].run_id)
        self.assertEqual(run.status, RunStatus.AWAITING_APPROVAL)
        store.close()

    def test_agentcore_stub_not_configured(self):
        import os

        if os.environ.get("AGENTCORE_RUNTIME_ARN") and os.environ.get("AWS_REGION"):
            self.skipTest("环境已配置 AgentCore，跳过未配置用例")
        runtime = AgentCoreRuntime(region="", runtime_arn="")
        # 构造参数为空时回退环境变量；显式清空环境不可控，直接断言两类行为之一
        health = runtime.health()
        self.assertIn(health["status"], ("not_configured", "configured_stub"))
        if health["status"] == "not_configured":
            with self.assertRaises(RuntimeNotConfigured):
                runtime.create_session(USER, "chat")
            with self.assertRaises(RuntimeNotConfigured):
                list(runtime.invoke("s", "hi", {}))
            self.assertIn("AGENTCORE_RUNTIME_ARN", health["hint"])


if __name__ == "__main__":
    unittest.main()
