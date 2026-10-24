"""演示种子：seed_if_empty 在库中无脚本时一次性写入。

内容：Feed 提示词 v1、主聊一条、示例脚本 2 个（meme 买入严格按细节设计 §6、
Aave 收益）、绑定 Aave 脚本的定时任务 1 个（每 60 分钟，下一次在 60 分钟后）、
记忆种子 2 条（fact 已生效、inference 待批准）、脚本导出文件登记 2 条。
已有脚本（用户数据）时整批跳过，绝不覆盖。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from .domain import Chat, Job, MemoryItem, Script
from .scheduler import fmt_iso

DEFAULT_USER = "demo-user"
FEED_PROMPT_V1 = (
    "我想看什么：DeFi、meme 和市场大盘都看，重点关注 meme 新币异动、"
    "Aave 等借贷协议的利率与治理动态。"
)

MEME_SCRIPT_DOC: dict[str, Any] = {
    "name": "新闻驱动 meme 买入",
    "description": "从新闻定位 meme 标的：查流动性与风险 → 报价 → 审批后模拟成交。",
    "entity": {"token": "BONK", "chain": "solana"},
    "params": [
        {"key": "amount_usd", "label": "买入金额（美元）", "type": "number",
         "default": 100},
        {"key": "token", "label": "代币", "type": "string",
         "default": "${entity.token}"},
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

AAVE_SCRIPT_DOC: dict[str, Any] = {
    "name": "Aave 收益脚本",
    "description": "查 Aave 利率并模拟存入测算收益（只模拟，不动真钱）。",
    "params": [
        {"key": "asset", "label": "资产", "type": "string", "default": "USDC"},
        {"key": "amount_usd", "label": "存入金额（美元）", "type": "number",
         "default": 1000},
        {"key": "days", "label": "测算天数", "type": "number", "default": 365},
    ],
    "steps": [
        {"tool": "aave.rates", "args": {"asset": "${asset}"}, "save_as": "rates"},
    ],
    "requires_approval_before_step": 1,
    "final_step": {
        "tool": "aave.sim_supply",
        "args": {"asset": "${asset}", "amount_usd": "${amount_usd}",
                 "days": "${days}"},
    },
}


def seed_if_empty(
    store: Any, user_id: str = DEFAULT_USER, now: datetime | None = None
) -> bool:
    """库中已有脚本则跳过（返回 False）；完成播种返回 True。"""
    if store.list_scripts(user_id):
        return False
    moment = now or datetime.now().astimezone()

    if store.get_prompt(user_id, "feed") is None:
        store.set_prompt(user_id, "feed", FEED_PROMPT_V1)
    if not store.list_chats(user_id):
        store.create_chat(Chat(user_id=user_id, title="主聊", kind="main"))

    meme = store.create_script(Script(
        user_id=user_id, name=str(MEME_SCRIPT_DOC["name"]), doc=MEME_SCRIPT_DOC,
        description=str(MEME_SCRIPT_DOC["description"])))
    aave = store.create_script(Script(
        user_id=user_id, name=str(AAVE_SCRIPT_DOC["name"]), doc=AAVE_SCRIPT_DOC,
        description=str(AAVE_SCRIPT_DOC["description"])))

    for script in (meme, aave):
        blob = json.dumps(script.doc, ensure_ascii=False, indent=2)
        store.add_file(user_id, f"{script.name}.json", "script_export",
                       f"script:{script.id}", size=len(blob.encode("utf-8")))

    store.create_job(Job(
        user_id=user_id, name="每小时看 Aave 收益", script_id=aave.id,
        trigger_type="time", trigger_spec={"every_minutes": 60},
        params={}, enabled=True,
        next_fire_at=fmt_iso(moment + timedelta(minutes=60))))

    store.add_memory(MemoryItem(
        user_id=user_id, content="用户偏好简洁、结论先行的回复。",
        level="fact", status="active", source="seed"))
    store.add_memory(MemoryItem(
        user_id=user_id, content="用户可能偏好 meme 赛道（待确认）。",
        level="inference", status="pending", source="seed"))
    return True
