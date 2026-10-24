"""模型适配：MockModel（默认、确定性）/ OpenRouterModel（可选，urllib 直连）。

MockModel 的 complete 与 plan 均为确定性实现：同一输入同一输出，无随机、无网络。
plan 返回 execution.Plan 结构，与场景口径对齐：
- script_build：按脚本构建手册六步产计划（scan -> quote -> 审批前 sim_swap）。
- chat：按目标中出现的标的决定是否查行情，否则空步计划（纯对话）。
- feed_brief：news.search 一步。
OpenRouterModel 缺 API key 时在构造/调用时抛 DemoError 写明配置方法，不沉默降级。
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

from .errors import DemoError
from .execution import Plan, Step, tool_step

_TOKEN_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}\b")
_AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:美元|USD|刀|块)")


def _find_token(text: str) -> str | None:
    from .tools import KNOWN_PRICES

    for cand in _TOKEN_RE.findall(text.upper()):
        if cand in KNOWN_PRICES:
            return cand
    m = _TOKEN_RE.search(text.upper())
    return m.group(0) if m else None


def _find_amount(text: str) -> tuple[float, bool]:
    """抽金额；返回 (金额, 是否用了默认值)。漏抽时默认 100 且必须留痕。"""
    m = _AMOUNT_RE.search(text)
    if m:
        return float(m.group(1)), False
    return 100.0, True


def _validate_plan(plan: Plan) -> Plan:
    """plan 入境白名单校验：任一步的工具不在注册表内直接报错，不进执行层。

    递归覆盖 children / routes / delegate 子计划。模型漏标 needs_approval
    的问题由执行层统一审批门兜底（execution.Orchestrator），这里只管
    「工具是否存在」这一道入境检查。
    """
    from .tools import TOOLS

    def walk(steps: list[Step]) -> None:
        for step in steps:
            if step.tool is not None and step.tool not in TOOLS:
                raise DemoError(f"计划含未知工具（不在白名单）：{step.tool}")
            walk(step.children)
            for branch in step.routes.values():
                walk([branch])
            if step.subplan is not None:
                walk(step.subplan.steps)

    walk(plan.steps)
    return plan


class MockModel:
    """确定性模拟模型：离线演示与单测的默认实现。"""

    name = "mock"

    def complete(self, messages: list[dict[str, str]]) -> str:
        last = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                last = msg.get("content", "")
                break
        if not last and messages:
            last = messages[-1].get("content", "")
        # 意图顺序：先判 Aave（「查 AAVE 利率」里 AAVE 本身是已知 token，
        # 若先判 token 永远走 meme 话术、进不了 Aave 分支——评审 P2）。
        if "aave" in last.lower() or "利率" in last or "收益" in last:
            return (
                "（模拟回复）可以先查 Aave 各资产利率，再做模拟存入测算，"
                "全程只模拟、不动真钱；满意后可存成脚本并设定时任务定期重跑。"
            )
        token = _find_token(last)
        if "meme" in last.lower() or token:
            tgt = token or "该标的"
            return (
                f"（模拟回复）已定位标的 {tgt}。按脚本构建六步：先查流动性与风险，"
                "再报价、模拟成交，敏感步骤停在审批，确认后保存为脚本可重跑。"
            )
        return f"（模拟回复）已收到：{last[:80]}。我可以陪你把它变成可保存、可重跑的脚本。"

    def plan(self, scene: str, goal: str) -> Plan:
        if scene == "script_build":
            token = _find_token(goal) or "BONK"
            amount, amount_defaulted = _find_amount(goal)
            steps = [
                tool_step("meme.scan", {"token": token}, save_as="scan",
                          label="查流动性与风险"),
                tool_step("dex.quote", {"token": token, "amount_usd": amount},
                          save_as="quote", label="报价"),
                tool_step("dex.sim_swap", {"token": token, "amount_usd": amount},
                          save_as="swap", label="模拟成交", needs_approval=True),
            ]
            # 金额漏抽用了默认值时在 metadata 留痕，不再静默猜（评审 P2）。
            return _validate_plan(Plan(
                goal=goal, scene=scene, steps=steps,
                metadata={"planner": "mock", "playbook": "script-building",
                          "amount_defaulted": amount_defaulted}))
        if scene == "feed_brief":
            return _validate_plan(Plan(
                goal=goal, scene=scene,
                steps=[tool_step("news.search", {"query": goal[:20]}, save_as="news",
                                 label="检索新闻池")],
                metadata={"planner": "mock"},
            ))
        token = _find_token(goal)
        steps: list[Step] = []
        if token:
            steps.append(tool_step("market.quote", {"symbol": token},
                                   save_as="quote", label="查现价"))
        return _validate_plan(Plan(goal=goal, scene=scene, steps=steps,
                                   metadata={"planner": "mock"}))


class OpenRouterModel:
    """OpenRouter 直连实现（标准库 urllib）。缺 key 抛 DemoError 并写明配法。"""

    name = "openrouter"
    API_URL = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
        self.model = model or os.environ.get(
            "OPENROUTER_MODEL", "openai/gpt-4o-mini"
        )

    def _require_key(self) -> None:
        if not self.api_key:
            raise DemoError(
                "OpenRouterModel 未配置 API key：请设置环境变量 OPENROUTER_API_KEY，"
                "或构造时传入 api_key；离线演示请改用 MockModel。"
            )

    def complete(self, messages: list[dict[str, str]]) -> str:
        self._require_key()
        body = json.dumps({"model": self.model, "messages": messages}).encode("utf-8")
        req = urllib.request.Request(
            self.API_URL,
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - 固定官方地址
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]

    def plan(self, scene: str, goal: str) -> Plan:
        """请模型产 JSON 计划并解析为 Plan；解析失败时明确抛错（不伪造计划）。"""
        self._require_key()
        prompt = (
            "你是计划器。只输出 JSON：{\"steps\":[{\"tool\":..,\"args\":{},"
            "\"save_as\":..,\"needs_approval\":false}]}。可用工具仅限白名单："
            "market.quote/meme.scan/dex.quote/dex.sim_swap/aave.rates/"
            f"aave.sim_supply/news.search/web.fetch/notify.send。场景={scene}，目标={goal}"
        )
        text = self.complete(
            [{"role": "user", "content": prompt}]
        )
        try:
            doc = json.loads(text[text.index("{"): text.rindex("}") + 1])
            steps = [
                tool_step(
                    s["tool"], s.get("args") or {},
                    save_as=s.get("save_as"),
                    needs_approval=bool(s.get("needs_approval", False)),
                )
                for s in doc.get("steps", [])
            ]
        except (ValueError, KeyError, TypeError) as exc:
            raise DemoError(f"OpenRouter 计划解析失败：{exc}") from exc
        # 入境白名单校验：模型编造的未知工具名直接报错，不进执行层。
        return _validate_plan(Plan(goal=goal, scene=scene, steps=steps,
                                   metadata={"planner": "openrouter",
                                             "model": self.model}))
