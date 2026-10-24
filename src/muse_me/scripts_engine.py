"""脚本引擎：草稿构建 / DSL 校验（沙箱）/ 试运行 / 正式执行 / 审批续跑。

脚本是数据不是代码（架构 §5）：步骤只能调用白名单原子工具，插值只允许
${param} 与 ${step.field} 两类（另加构建上下文 ${entity.field}，entity 来自
脚本来源 Feed 条目的实体）。执行全程落 Run + RunEvent，轨迹即事实。

审批语义：门位（gate）= doc.requires_approval_before_step 显式指定，
并自动补上第一个非 auto 风险步。走到门位时查 (run_id, step_index) 的审批：
- 无审批 → 建 Approval、Run 转 awaiting_approval、挂起返回；
- pending → 保持挂起；
- approved → 放行继续；
- denied → Run 失败收口。
试运行（trial=True）不建审批、不挂起，写工具一律 simulate 模式跑完给结果。

金额护栏：任一步解析后的 amount_usd/amount 超 GuardrailPolicy.max_sim_amount_usd
直接 GuardrailDenied（先落 run_failed 再抛，轨迹里留得下原因）。
"""
from __future__ import annotations

import re
from typing import Any

from .domain import (
    Approval,
    FeedItem,
    GuardrailPolicy,
    Run,
    RunEvent,
    RunStatus,
    Script,
)
from .errors import GuardrailDenied, NotFound, ValidationFailed
from .llm import MockModel
from .tools import TOOLS

_INTERP_RE = re.compile(r"\$\{([^{}]+)\}")
_EXPR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")
_AMOUNT_KEYS = ("amount_usd", "amount")


# ---------------------------------------------------------------- 草稿构建
def build_draft(
    intent: str,
    feed_item: FeedItem | dict[str, Any] | None = None,
    model: MockModel | None = None,
) -> dict[str, Any]:
    """把用户意图（+可选 Feed 上下文）拼成 DSL 草稿。

    抽取口径复用 MockModel.plan（script_build 场景六步计划）；
    Aave 类意图走收益脚本骨架。feed_item 给定时 token 参数默认 ${entity.token}。
    """
    model = model or MockModel()
    text = intent or ""
    entities: dict[str, Any] = {}
    news_title = ""
    if feed_item is not None:
        if isinstance(feed_item, FeedItem):
            entities = dict(feed_item.entities or {})
            news_title = feed_item.title
        else:
            entities = dict(feed_item.get("entities") or {})
            news_title = str(feed_item.get("title") or "")
    haystack = f"{text} {news_title}"
    lowered = haystack.lower()
    if "aave" in lowered or any(k in haystack for k in ("利率", "收益", "存入", "借贷")):
        asset = entities.get("token") or "USDC"
        return {
            "name": "Aave 收益脚本",
            "description": "查 Aave 利率并模拟存入测算收益（只模拟，不动真钱）。",
            "params": [
                {"key": "asset", "label": "资产", "type": "string", "default": asset},
                {"key": "amount_usd", "label": "存入金额（美元）", "type": "number",
                 "default": 1000},
                {"key": "days", "label": "测算天数", "type": "number", "default": 365},
            ],
            "steps": [
                {"tool": "aave.rates", "args": {"asset": "${asset}"},
                 "save_as": "rates"},
            ],
            "requires_approval_before_step": 1,
            "final_step": {
                "tool": "aave.sim_supply",
                "args": {"asset": "${asset}", "amount_usd": "${amount_usd}",
                         "days": "${days}"},
            },
        }
    plan = model.plan("script_build", haystack)
    token = ""
    amount: float = 100.0
    for step in plan.steps:
        if step.tool == "dex.quote":
            token = str(step.args.get("token") or token)
            amount = float(step.args.get("amount_usd") or amount)
    if entities.get("token"):
        token = str(entities["token"])
    token_default: Any = "${entity.token}" if entities.get("token") else (token or "BONK")
    draft: dict[str, Any] = {
        "name": "新闻驱动 meme 买入",
        "description": "从新闻定位 meme 标的：查流动性与风险 → 报价 → 审批后模拟成交。",
        "params": [
            {"key": "amount_usd", "label": "买入金额（美元）", "type": "number",
             "default": amount},
            {"key": "token", "label": "代币", "type": "string",
             "default": token_default},
        ],
        "steps": [
            {"tool": "meme.scan", "args": {"token": "${token}"}, "save_as": "scan"},
            {"tool": "dex.quote",
             "args": {"token": "${token}", "amount_usd": "${amount_usd}"},
             "save_as": "quote"},
        ],
        "requires_approval_before_step": 2,
        "final_step": {
            "tool": "dex.sim_swap",
            "args": {"token": "${token}", "amount_usd": "${amount_usd}"},
        },
    }
    if entities:
        # 构建上下文随脚本保存：${entity.*} 在日后重跑时仍可解析
        draft["entity"] = entities
    return draft


# ---------------------------------------------------------------- DSL 校验
def effective_steps(doc: dict[str, Any]) -> list[dict[str, Any]]:
    steps = list(doc.get("steps") or [])
    if doc.get("final_step"):
        steps.append(doc["final_step"])
    return steps


def _check_interpolations(
    value: Any, allowed_heads: set[str], where: str
) -> None:
    if isinstance(value, str):
        for expr in _INTERP_RE.findall(value):
            if not _EXPR_RE.match(expr):
                raise ValidationFailed(f"{where} 含非法插值表达式：${{{expr}}}")
            head = expr.split(".", 1)[0]
            if head not in allowed_heads:
                raise ValidationFailed(
                    f"{where} 插值 ${{{expr}}} 引用了未定义的名字：{head}"
                )
        # 不完整的 ${ 也拒绝（沙箱口径：宁严勿松）
        stripped = _INTERP_RE.sub("", value)
        if "${" in stripped:
            raise ValidationFailed(f"{where} 含未闭合插值：{value}")
    elif isinstance(value, dict):
        for v in value.values():
            _check_interpolations(v, allowed_heads, where)
    elif isinstance(value, list):
        for v in value:
            _check_interpolations(v, allowed_heads, where)


def validate_script(doc: Any, tools_index: dict[str, Any] | None = None) -> dict[str, Any]:
    """校验脚本 DSL；合法返回 doc，非法抛 ValidationFailed。"""
    tools_index = tools_index if tools_index is not None else TOOLS
    if not isinstance(doc, dict):
        raise ValidationFailed("脚本必须是 JSON 对象")
    name = doc.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValidationFailed("脚本缺少 name")
    params = doc.get("params") or []
    if not isinstance(params, list):
        raise ValidationFailed("params 必须是数组")
    param_keys: set[str] = set()
    for p in params:
        if not isinstance(p, dict) or not p.get("key"):
            raise ValidationFailed(f"参数定义不合法：{p!r}")
        if p.get("type", "string") not in ("string", "number"):
            raise ValidationFailed(f"参数 {p['key']} 的 type 只允许 string/number")
        param_keys.add(str(p["key"]))
    steps = effective_steps(doc)
    if not steps:
        raise ValidationFailed("脚本至少需要一步（steps 或 final_step）")
    save_as_seen: set[str] = set()
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValidationFailed(f"第 {i} 步必须是对象")
        tool = step.get("tool")
        if tool not in tools_index:
            raise ValidationFailed(f"第 {i} 步工具不在白名单：{tool}")
        args = step.get("args") or {}
        if not isinstance(args, dict):
            raise ValidationFailed(f"第 {i} 步 args 必须是对象")
        allowed = param_keys | save_as_seen | {"entity"}
        _check_interpolations(args, allowed, f"第 {i} 步")
        save_as = step.get("save_as")
        if save_as:
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(save_as)):
                raise ValidationFailed(f"第 {i} 步 save_as 不合法：{save_as}")
            if save_as in save_as_seen:
                raise ValidationFailed(f"save_as 重复：{save_as}")
            save_as_seen.add(str(save_as))
    for p in params:
        _check_interpolations(
            p.get("default"), param_keys | {"entity"}, f"参数 {p.get('key')} 默认值"
        )
    gate = doc.get("requires_approval_before_step")
    if gate is not None:
        if not isinstance(gate, int) or isinstance(gate, bool) or not (0 <= gate <= len(steps)):
            raise ValidationFailed(
                f"requires_approval_before_step 须为 0..{len(steps)} 的整数"
            )
    return doc


def gate_steps(doc: dict[str, Any], policy: GuardrailPolicy) -> set[int]:
    """计算门位集合：显式 gate + 第一个非 auto 风险步。"""
    gates: set[int] = set()
    gate = doc.get("requires_approval_before_step")
    if isinstance(gate, int) and not isinstance(gate, bool):
        gates.add(gate)
    for i, step in enumerate(effective_steps(doc)):
        tool = TOOLS.get(step.get("tool"))
        if tool is None:
            continue
        if policy.action_for_risk(tool.risk) != "auto":
            gates.add(i)
            break
    return gates


# ---------------------------------------------------------------- 参数解析
def _resolve(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, str):
        full = _INTERP_RE.fullmatch(value)
        if full:
            return _lookup(full.group(1), context)
        def repl(m: re.Match) -> str:
            resolved = _lookup(m.group(1), context)
            return "" if resolved is None else str(resolved)
        return _INTERP_RE.sub(repl, value)
    if isinstance(value, dict):
        return {k: _resolve(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve(v, context) for v in value]
    return value


def _lookup(expr: str, context: dict[str, Any]) -> Any:
    head, _, rest = expr.partition(".")
    value = context.get(head)
    if isinstance(value, dict) and rest:
        return value.get(rest)
    return value


def _merged_params(
    doc: dict[str, Any], overrides: dict[str, Any] | None, entity: dict[str, Any]
) -> dict[str, Any]:
    params: dict[str, Any] = {}
    base_ctx = {"entity": entity}
    for p in doc.get("params") or []:
        key = str(p["key"])
        if p.get("default") is not None:
            params[key] = _resolve(p["default"], {**base_ctx, **params})
    for key, value in (overrides or {}).items():
        params[key] = value
    for p in doc.get("params") or []:
        key = str(p["key"])
        if p.get("type") == "number" and params.get(key) is not None:
            try:
                params[key] = float(params[key])
            except (TypeError, ValueError):
                raise ValidationFailed(f"参数 {key} 需要数字，收到 {params[key]!r}")
    return params


# ---------------------------------------------------------------- 执行
def _find_approval(store: Any, run_id: str, step_index: int) -> Approval | None:
    for ap in store.list_approvals(None):
        if ap.run_id == run_id and ap.step_index == step_index:
            return ap
    return None


def _emit(store: Any, run_id: str, type_: str, payload: dict[str, Any]) -> RunEvent:
    return store.add_run_event(RunEvent(run_id=run_id, type=type_, payload=payload))


def run_script(
    store: Any,
    registry: Any,
    policy: GuardrailPolicy,
    *,
    user_id: str,
    script: Script,
    params: dict[str, Any] | None = None,
    trial: bool = False,
    source: str = "script",
    job_id: str | None = None,
    entity: dict[str, Any] | None = None,
    doc: dict[str, Any] | None = None,
    harness_version: str = "",
) -> dict[str, Any]:
    """执行脚本（新建 Run）。trial=True 为沙箱试运行：不建审批、全程 simulate。"""
    doc = doc if doc is not None else script.doc
    validate_script(doc)
    run = Run(user_id=user_id, scene="script", source=source, script_id=script.id,
              job_id=job_id, harness_version=harness_version)
    store.create_run(run)
    ent = dict(entity or doc.get("entity") or {})
    if not ent and script.origin_feed_item_id:
        item = store.get_feed_item(script.origin_feed_item_id)
        if item is not None:
            ent = dict(item.entities or {})
    merged = _merged_params(doc, params, ent)
    _emit(store, run.id, "plan_created", {
        "script_id": script.id, "script_name": script.name,
        "version": script.current_version, "steps": len(effective_steps(doc)),
        "params": merged, "entity": ent, "trial": trial,
    })
    return _execute(store, registry, policy, run=run, doc=doc, params=merged,
                    entity=ent, trial=trial, completed=set(), facts={}, spent=0.0,
                    results=[])


def resume_script(
    store: Any,
    registry: Any,
    policy: GuardrailPolicy,
    *,
    run_id: str,
    harness_version: str = "",
) -> dict[str, Any]:
    """审批后续跑：从 run_events 重建已完成步/事实板/已花费，再继续解释执行。"""
    run = store.get_run(run_id)
    if run is None or run.script_id is None:
        raise NotFound(f"脚本运行不存在：{run_id}")
    script = store.get_script(run.script_id)
    if script is None:
        raise NotFound(f"脚本不存在：{run.script_id}")
    events = store.list_run_events(run_id)
    plan_event = next((e for e in events if e.type == "plan_created"), None)
    if plan_event is None:
        raise NotFound(f"运行缺少 plan_created 事件：{run_id}")
    saved = plan_event.payload or {}
    version = saved.get("version") or script.current_version
    versioned = store.get_script_version(script.id, int(version))
    doc = versioned.doc if versioned is not None else script.doc
    params = dict(saved.get("params") or {})
    entity = dict(saved.get("entity") or {})
    trial = bool(saved.get("trial"))
    completed: set[int] = set()
    facts: dict[str, Any] = {}
    results: list[dict[str, Any]] = []
    spent = 0.0
    for ev in events:
        if ev.type == "step_done":
            idx = int(ev.payload.get("step", -1))
            completed.add(idx)
            spent += float(ev.payload.get("cost_usd") or 0.0)
            if ev.payload.get("save_as"):
                facts[str(ev.payload["save_as"])] = ev.payload.get("result")
            results.append({"step": idx, "tool": ev.payload.get("tool"),
                            "result": ev.payload.get("result")})
    if run.status == RunStatus.AWAITING_APPROVAL:
        store.update_run_status(run_id, RunStatus.RUNNING)
        run = store.get_run(run_id)
    return _execute(store, registry, policy, run=run, doc=doc, params=params,
                    entity=entity, trial=trial, completed=completed, facts=facts,
                    spent=spent, results=results)


def _execute(
    store: Any,
    registry: Any,
    policy: GuardrailPolicy,
    *,
    run: Run,
    doc: dict[str, Any],
    params: dict[str, Any],
    entity: dict[str, Any],
    trial: bool,
    completed: set[int],
    facts: dict[str, Any],
    spent: float,
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    steps = effective_steps(doc)
    gates = gate_steps(doc, policy)
    context: dict[str, Any] = {**params, **facts, "entity": entity}

    def finish(status: str, **extra: Any) -> dict[str, Any]:
        return {"run_id": run.id, "status": status, "facts": facts,
                "steps": results, "spent_usd": round(spent, 6), **extra}

    for i, step in enumerate(steps):
        if i in completed:
            continue
        tool_name = str(step.get("tool"))
        tool = TOOLS.get(tool_name)
        resolved = _resolve(step.get("args") or {}, context)
        # 金额护栏（解析后、执行前）：超限先落轨迹再抛
        for key in _AMOUNT_KEYS:
            value = resolved.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if value > policy.max_sim_amount_usd:
                    _emit(store, run.id, "run_failed", {
                        "reason": "guardrail",
                        "error": f"金额 {value} 超过模拟上限 {policy.max_sim_amount_usd}",
                        "step": i, "tool": tool_name,
                    })
                    store.set_run_error(run.id, "guardrail: amount over limit")
                    store.update_run_status(run.id, RunStatus.FAILED)
                    raise GuardrailDenied(
                        f"金额 {value} 超过模拟上限 {policy.max_sim_amount_usd}，已拦截"
                    )
        if tool is not None and policy.action_for_risk(tool.risk) == "deny":
            _emit(store, run.id, "run_failed", {
                "reason": "guardrail", "step": i, "tool": tool_name,
                "error": f"护栏策略拒绝风险级 {tool.risk}",
            })
            store.update_run_status(run.id, RunStatus.FAILED)
            raise GuardrailDenied(f"护栏策略拒绝执行 {tool_name}（风险 {tool.risk}）")
        # 审批门
        if i in gates and not trial:
            approval = _find_approval(store, run.id, i)
            if approval is None:
                amount = next(
                    (resolved[k] for k in _AMOUNT_KEYS
                     if isinstance(resolved.get(k), (int, float))), None)
                approval = store.create_approval(Approval(
                    run_id=run.id, step_index=i, action=tool_name,
                    risk=tool.risk if tool else "write",
                    amount_usd=float(amount) if amount is not None else None,
                ))
                _emit(store, run.id, "approval_required", {
                    "step": i, "tool": tool_name, "approval_id": approval.id,
                })
                store.update_run_status(run.id, RunStatus.AWAITING_APPROVAL)
                return finish("awaiting_approval", approval_id=approval.id)
            if approval.status.value == "pending":
                return finish("awaiting_approval", approval_id=approval.id)
            if approval.status.value == "denied":
                _emit(store, run.id, "run_failed", {
                    "reason": "denied", "step": i, "tool": tool_name,
                    "error": approval.reason or "用户拒绝",
                })
                store.update_run_status(run.id, RunStatus.FAILED)
                return finish("failed", error="denied")
        _emit(store, run.id, "step_started", {"step": i, "tool": tool_name})
        _emit(store, run.id, "tool_called",
              {"step": i, "tool": tool_name, "args": resolved})
        try:
            result = registry.call(tool_name, resolved, mode="simulate")
        except Exception as exc:
            _emit(store, run.id, "step_failed",
                  {"step": i, "tool": tool_name, "error": str(exc)})
            _emit(store, run.id, "run_failed",
                  {"reason": "step_failed", "step": i, "error": str(exc)})
            store.set_run_error(run.id, str(exc))
            store.update_run_status(run.id, RunStatus.FAILED)
            return finish("failed", error=str(exc))
        if not isinstance(result, dict):
            result = {"value": result}
        cost = float(result.get("cost_usd") or 0.0)
        spent += cost
        if cost:
            store.add_run_cost(run.id, cost)
        save_as = step.get("save_as")
        if save_as:
            facts[str(save_as)] = result
            context[str(save_as)] = result
        _emit(store, run.id, "step_done", {
            "step": i, "tool": tool_name, "save_as": save_as,
            "result": result, "cost_usd": cost,
        })
        results.append({"step": i, "tool": tool_name, "result": result})
        if spent > policy.max_cost_per_run_usd:
            _emit(store, run.id, "run_failed", {
                "reason": "budget", "spent_usd": round(spent, 6),
                "limit_usd": policy.max_cost_per_run_usd,
            })
            store.set_run_error(run.id, "budget")
            store.update_run_status(run.id, RunStatus.FAILED)
            return finish("failed", error="budget")
    _emit(store, run.id, "run_done", {"facts": list(facts.keys()),
                                      "spent_usd": round(spent, 6)})
    store.update_run_status(run.id, RunStatus.DONE)
    return finish("done")
