"""评估层：回归集 runner + 迭代门（复用 ShadowClaw 口径）。

- 用例在仓库根 evaluation/cases/*.json，每例含 id/kind/input/expect。
- runner 在内存库沙箱里逐例执行程序硬查（模型裁判权重默认 0，不调模型），
  输出 dict 报告：{"total", "passed", "failed", "cases": [{id, ok, detail}]}。
- gate(baseline, candidate)：候选不得出现基线之外的新失败，且通过数不低于基线。
离线运行：python -m muse_me.evaluation [cases_dir]
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def default_cases_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "evaluation" / "cases"


def load_cases(cases_dir: str | Path | None = None) -> list[dict[str, Any]]:
    base = Path(cases_dir) if cases_dir is not None else default_cases_dir()
    cases: list[dict[str, Any]] = []
    for path in sorted(base.glob("*.json")):
        cases.append(json.loads(path.read_text(encoding="utf-8")))
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
            services["memories"].add(str(inp["content"]), level="inference")
            active = [m.content for m in services["memories"].active()]
            pending = [m for m in services["memories"].list(status="pending")
                       if m.content == inp["content"]]
            if inp["content"] in active:
                return False, "推断记忆未批准就生效了"
            if not pending:
                return False, "推断记忆没有进入待批准区"
            services["memories"].decide(pending[0].id, approved=True)
            active_after = [m.content for m in services["memories"].active()]
            if inp["content"] not in active_after:
                return False, "批准后推断记忆仍未生效"
            return True, "推断记忆先 pending，批准后才生效"

        if kind == "job_time_trigger_approval":
            from datetime import datetime, timedelta

            from .scheduler import SchedulerDaemon, fmt_iso

            aave = next(s for s in services["scripts"].list()
                        if "Aave" in s.name)
            job = services["jobs"].create(
                name="评估用定时任务", script_id=aave.id,
                trigger={"type": "time", "every_minutes": 60})
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
            pending = store.list_approvals(user, status="pending")
            if not fired or not job_runs:
                return False, "到点未执行（无 job_runs）"
            if not pending:
                return False, "敏感步没有转审批"
            return True, f"到点执行 {len(job_runs)} 次，敏感步已转审批"

        return False, f"未知用例类型：{kind}"
    finally:
        store.close()


def run_cases(cases_dir: str | Path | None = None) -> dict[str, Any]:
    """逐例运行回归集，返回 dict 报告。"""
    results: list[dict[str, Any]] = []
    for case in load_cases(cases_dir):
        try:
            ok, detail = _run_case(case)
        except Exception as exc:  # 单例异常不拖垮整套
            ok, detail = False, f"用例异常：{exc}"
        results.append({"id": case.get("id", "?"), "ok": ok, "detail": detail})
    passed = sum(1 for r in results if r["ok"])
    return {"total": len(results), "passed": passed,
            "failed": len(results) - passed, "cases": results}


def gate(baseline: Any, candidate: Any) -> bool:
    """迭代门：候选无新失败且通过数不低于基线，才允许合入驾驭层变更。

    入参可为 run_cases 的报告 dict，或直接是通过数（int）。
    """
    if isinstance(baseline, (int, float)) and isinstance(candidate, (int, float)):
        return candidate >= baseline
    base_cases = {c["id"]: bool(c["ok"]) for c in (baseline or {}).get("cases", [])}
    cand_cases = {c["id"]: bool(c["ok"]) for c in (candidate or {}).get("cases", [])}
    base_failed = {cid for cid, ok in base_cases.items() if not ok}
    cand_failed = {cid for cid, ok in cand_cases.items() if not ok}
    if not cand_failed.issubset(base_failed):
        return False
    return sum(cand_cases.values()) >= sum(base_cases.values())


if __name__ == "__main__":  # python -m muse_me.evaluation
    import sys

    report = run_cases(sys.argv[1] if len(sys.argv) > 1 else None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
