"""评估层：回归集 runner + 迭代门（复用 ShadowClaw 口径）。

- 用例在仓库根 evaluation/cases/*.json，每例含 id/kind/input/expect；
  runner 逐例**真消费 input/expect 逐项断言**，写死期望不算数。
- runner 在内存库沙箱里逐例执行程序硬查（模型裁判权重默认 0，不调模型），
  输出 dict 报告：{"total", "passed", "failed", "cases": [{id, ok, detail}]}。
- load_cases 单文件容错：某个 JSON 损坏只让该例记 fail，不拖垮整套
  （与 runner 单例隔离同一口径）。
- gate(baseline, candidate)：用例集合只增不减（基线用例在候选里缺失即
  不通过）、候选不得出现基线之外的新失败、且通过数不低于基线。
离线运行：python -m muse_me.evaluation [cases_dir]
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def default_cases_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "evaluation" / "cases"


def load_cases(cases_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """逐文件加载用例；单个 JSON 损坏不整套崩：坏文件变成一条带
    _load_error 标记的占位用例，由 run_cases 记为该例 fail 并继续其余。
    占位 id 由文件名决定（跨运行稳定），保证 gate 的集合一致性可比对。"""
    base = Path(cases_dir) if cases_dir is not None else default_cases_dir()
    cases: list[dict[str, Any]] = []
    for path in sorted(base.glob("*.json")):
        try:
            cases.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception as exc:
            cases.append({"id": f"broken:{path.name}", "kind": "__load_error__",
                          "_load_error": f"{path.name} 解析失败：{exc}"})
    return cases


def _sandbox():
    """每例独立沙箱：内存库 app（不启调度线程），保证用例互不污染。"""
    from .bootstrap import create_app

    return create_app({"db_path": ":memory:", "start_scheduler": False})


def _run_case(case: dict[str, Any]) -> tuple[bool, str]:
    kind = case.get("kind")
    inp = case.get("input") or {}
    expect = case.get("expect") or {}
    app = _sandbox()
    store, services = app.store, app.services
    user = app.user_id
    try:
        if kind == "script_build_six_steps":
            item = None
            if inp.get("feed_title"):
                from .domain import FeedItem

                item = FeedItem(user_id=user, title=inp["feed_title"],
                                summary=inp.get("feed_summary", ""),
                                entities=inp.get("entities") or {})
            draft = services["scripts"].build_draft(
                str(inp.get("intent", "")), feed_item=item)
            steps = list(draft.get("steps") or [])
            if draft.get("final_step"):
                steps.append(draft["final_step"])
            tools_used = [s.get("tool") for s in steps]
            if tools_used != expect.get("tools"):
                return False, f"工具序列 {tools_used} != 期望 {expect.get('tools')}"
            if draft.get("requires_approval_before_step") != expect.get("gate"):
                return False, f"审批门位 {draft.get('requires_approval_before_step')} != {expect.get('gate')}"
            saved = services["scripts"].save_draft(draft)
            trial = services["scripts"].trial(saved.id)
            if trial["status"] != "done":
                return False, f"试运行未完成：{trial['status']}"
            if store.list_approvals(user, status="pending"):
                return False, "试运行不应产生待审批"
            return True, "构建六步齐全，试运行完成且保存成功"

        if kind == "guardrail_over_amount":
            from .errors import GuardrailDenied

            draft = services["scripts"].build_draft(str(inp.get("intent", "")))
            saved = services["scripts"].save_draft(draft)
            blocked = False
            try:
                services["scripts"].run(
                    saved.id, params={"amount_usd": float(inp["amount_usd"])})
            except GuardrailDenied:
                blocked = True
            runs = [r for r in store.list_runs(user)
                    if r.script_id == saved.id]
            failed = any(r.status.value == "failed" for r in runs)
            if blocked and failed == bool(expect.get("run_failed", True)):
                return True, f"金额 {inp['amount_usd']} 被护栏拦截，Run 已失败收口"
            return False, f"blocked={blocked} run_failed={failed}"

        if kind == "memory_inference_gate":
            # expect 逐项真断言：active_before_approval / active_after_approval
            # 与实测逐项比对，改坏 JSON 里的期望值本例就会变红。
            for field in ("active_before_approval", "active_after_approval"):
                if field not in expect:
                    return False, f"expect 缺字段 {field}，无法断言"
            content = str(inp["content"])
            services["memories"].add(
                content, level=str(inp.get("level", "inference")))
            active_before = content in [
                m.content for m in services["memories"].active()]
            if active_before != bool(expect["active_before_approval"]):
                return False, (f"批准前生效状态 {active_before} != "
                               f"期望 {expect['active_before_approval']}")
            pending = [m for m in services["memories"].list(status="pending")
                       if m.content == content]
            if not pending:
                return False, "推断记忆没有进入待批准区"
            services["memories"].decide(pending[0].id, approved=True)
            active_after = content in [
                m.content for m in services["memories"].active()]
            if active_after != bool(expect["active_after_approval"]):
                return False, (f"批准后生效状态 {active_after} != "
                               f"期望 {expect['active_after_approval']}")
            return True, "推断记忆先 pending，批准后才生效（expect 逐项已核）"

        if kind == "job_time_trigger_approval":
            from datetime import datetime, timedelta

            from .scheduler import SchedulerDaemon, fmt_iso

            # trigger 真读 input（不再硬编码）：JSON 写什么就按什么建 job。
            trigger = inp.get("trigger")
            if not isinstance(trigger, dict) or not trigger:
                return False, "input.trigger 缺失或不是对象，无法建任务"
            aave = next(s for s in services["scripts"].list()
                        if "Aave" in s.name)
            job = services["jobs"].create(
                name="评估用定时任务", script_id=aave.id, trigger=trigger)
            job.next_fire_at = fmt_iso(
                datetime.now().astimezone() - timedelta(minutes=1))
            store.update_job(job)
            daemon = SchedulerDaemon(
                store,
                lambda j, params, entity: services["scripts"].run(
                    j.script_id, params=params, source="job", job_id=j.id,
                    entity=entity, version=j.script_version),
                app.registry, user_id=user, retry_backoff=0)
            fired = daemon.tick()
            job_runs = store.list_job_runs(job.id)
            if not fired:
                return False, "到点未执行（tick 未触发）"
            # expect.job_runs_min 逐项真断言。
            runs_min = int(expect.get("job_runs_min", 1))
            if len(job_runs) < runs_min:
                return False, (f"job_runs {len(job_runs)} 条 < "
                               f"期望至少 {runs_min} 条")
            # expect.approval_pending 断言带归属：pending 审批必须属于
            # 本 job 本次产生的 run（经 JobRun.run_id 关联），
            # 沙箱里存在任意 pending 不算数。
            job_run_ids = {jr.run_id for jr in job_runs if jr.run_id}
            own_pending = [a for a in store.list_approvals(
                user, status="pending") if a.run_id in job_run_ids]
            if bool(own_pending) != bool(expect.get("approval_pending")):
                return False, (f"本 job 的 pending 审批 {len(own_pending)} 条，"
                               f"与期望 approval_pending="
                               f"{expect.get('approval_pending')} 不符")
            return True, (f"到点执行 {len(job_runs)} 次（>={runs_min}），"
                          f"敏感步已转审批且归属本 job")

        if kind == "resume_after_approval":
            # 脚本运行挂起审批 → 批准 → 续跑完成；已完成步不得重复执行
            # （以 step_done / tool_called 事件计数逐项断言）。
            for field in ("suspended_status", "final_status"):
                if field not in expect:
                    return False, f"expect 缺字段 {field}，无法断言"
            draft = services["scripts"].build_draft(str(inp.get("intent", "")))
            saved = services["scripts"].save_draft(draft)
            first = services["scripts"].run(saved.id)
            if first.get("status") != expect["suspended_status"]:
                return False, (f"首次运行状态 {first.get('status')} != "
                               f"期望挂起 {expect['suspended_status']}")
            approval_id = first.get("approval_id")
            if not approval_id:
                return False, "首次运行未产生待审批"
            run_id = first["run_id"]
            services["approvals"].decide(approval_id, approved=True)
            run = store.get_run(run_id)
            final_status = run.status.value if run is not None else None
            if final_status != expect["final_status"]:
                return False, (f"续跑后 Run 状态 {final_status} != "
                               f"期望 {expect['final_status']}")
            if expect.get("steps_executed_once"):
                from collections import Counter

                events = store.list_run_events(run_id)
                done_counts = Counter(
                    e.payload.get("step") for e in events
                    if e.type == "step_done")
                call_counts = Counter(
                    e.payload.get("step") for e in events
                    if e.type == "tool_called")
                repeated = {s: n for s, n in done_counts.items() if n != 1}
                if repeated or done_counts != call_counts:
                    return False, (f"步骤重复执行：step_done={dict(done_counts)} "
                                   f"tool_called={dict(call_counts)}")
                if not events or events[-1].type != "run_done":
                    return False, "事件序列未以 run_done 收尾"
            return True, "挂起→批准→续跑完成，已完成步无重复执行"

        if kind == "quoted_amount_guardrail":
            # 金额写成字符串字面量（DSL args 里的 "99999"）也必须被护栏拦下；
            # 小额字符串 "50" 应正常通过到审批门。与 scripts_engine 的
            # 金额护栏修复对齐：修复未合入时 over 分支为红，不改断言凑绿。
            import copy

            from .errors import GuardrailDenied

            def run_quoted(amount_text: str, tag: str) -> tuple[bool, str]:
                draft = copy.deepcopy(services["scripts"].build_draft(
                    str(inp.get("intent", ""))))
                draft["name"] = f"{draft['name']}（{tag}）"
                hit = 0
                for step in list(draft.get("steps") or []) + (
                        [draft["final_step"]] if draft.get("final_step")
                        else []):
                    args = step.get("args") or {}
                    for key in ("amount_usd", "amount"):
                        if key in args:
                            args[key] = amount_text
                            hit += 1
                if not hit:
                    raise ValueError("草稿里没有 amount 步可注入引号金额")
                saved = services["scripts"].save_draft(draft)
                try:
                    result = services["scripts"].run(saved.id)
                    return False, str(result.get("status"))
                except GuardrailDenied:
                    runs = [r for r in store.list_runs(user)
                            if r.script_id == saved.id]
                    status = runs[0].status.value if runs else "no-run"
                    return True, status

            over_blocked, over_status = run_quoted(
                str(inp["over_amount"]), "超限引号金额")
            if over_blocked != bool(expect.get("over_blocked")):
                return False, (f"引号金额 {inp['over_amount']!r} "
                               f"blocked={over_blocked}，"
                               f"期望 {expect.get('over_blocked')}")
            if over_status != expect.get("over_run_status"):
                return False, (f"超限引号金额 Run 状态 {over_status} != "
                               f"期望 {expect.get('over_run_status')}")
            ok_blocked, ok_status = run_quoted(
                str(inp["ok_amount"]), "小额引号金额")
            if ok_blocked != bool(expect.get("ok_blocked")):
                return False, (f"引号金额 {inp['ok_amount']!r} "
                               f"blocked={ok_blocked}，"
                               f"期望 {expect.get('ok_blocked')}")
            if ok_status != expect.get("ok_status"):
                return False, (f"小额引号金额运行状态 {ok_status} != "
                               f"期望 {expect.get('ok_status')}")
            return True, ("引号金额超限被护栏拦截（Run failed），"
                          "小额引号金额正常到达审批门")

        if kind == "feed_stable_ids":
            # Feed 刷新前后同一条新闻 id 必须稳定（内容决定），否则
            # scheduler 的 event 基线会把旧新闻全当新条目误触发。
            first = {i.title: i.id for i in services["feed"].refresh()}
            second = {i.title: i.id for i in services["feed"].refresh()}
            min_items = int(expect.get("min_items", 1))
            if len(first) < min_items:
                return False, f"精选条目 {len(first)} 条 < 期望至少 {min_items}"
            stable = first == second
            if stable != bool(expect.get("stable_across_refresh")):
                return False, (f"两次刷新的 id 映射一致性 {stable} != "
                               f"期望 {expect.get('stable_across_refresh')}")
            return True, f"刷新前后 {len(first)} 条精选 id 全部稳定"

        return False, f"未知用例类型：{kind}"
    finally:
        store.close()


def run_cases(cases_dir: str | Path | None = None) -> dict[str, Any]:
    """逐例运行回归集，返回 dict 报告。"""
    results: list[dict[str, Any]] = []
    for case in load_cases(cases_dir):
        if case.get("_load_error"):
            # 坏文件在加载期就记 fail，不进 runner、也不拖垮其余用例
            results.append({"id": case.get("id", "?"), "ok": False,
                            "detail": f"用例文件损坏：{case['_load_error']}"})
            continue
        try:
            ok, detail = _run_case(case)
        except Exception as exc:  # 单例异常不拖垮整套
            ok, detail = False, f"用例异常：{exc}"
        results.append({"id": case.get("id", "?"), "ok": ok, "detail": detail})
    passed = sum(1 for r in results if r["ok"])
    return {"total": len(results), "passed": passed,
            "failed": len(results) - passed, "cases": results}


def gate(baseline: Any, candidate: Any) -> bool:
    """迭代门：满足三条才允许合入驾驭层变更。

    口径（防回归集缩水假绿）：
    1. 用例集合只增不减——基线里的每个用例 id 必须出现在候选里，
       缺任何一条即不通过（旧口径只比失败集包含关系，用例整条消失
       反而更容易过，正是要堵的洞）；候选新增用例允许。
    2. 候选不得出现基线之外的新失败（新增用例失败也算新失败）。
    3. 候选通过数不低于基线。
    入参可为 run_cases 的报告 dict，或直接是通过数（int，沿用旧口径）。
    """
    if isinstance(baseline, (int, float)) and isinstance(candidate, (int, float)):
        return candidate >= baseline
    base_cases = {c["id"]: bool(c["ok"]) for c in (baseline or {}).get("cases", [])}
    cand_cases = {c["id"]: bool(c["ok"]) for c in (candidate or {}).get("cases", [])}
    if not set(base_cases).issubset(cand_cases):
        return False
    base_failed = {cid for cid, ok in base_cases.items() if not ok}
    cand_failed = {cid for cid, ok in cand_cases.items() if not ok}
    if not cand_failed.issubset(base_failed):
        return False
    return sum(cand_cases.values()) >= sum(base_cases.values())


if __name__ == "__main__":  # python -m muse_me.evaluation
    import sys

    report = run_cases(sys.argv[1] if len(sys.argv) > 1 else None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
