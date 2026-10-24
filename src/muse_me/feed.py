"""今日精选：SeedNews（NewsSourcePort 实现）+ FeedGenerator。

新闻池直接复用 tools.DEFAULT_NEWS_POOL，保证 news.search 与 Feed 同源一致。
生成口径：从用户提示词抽关键词（已知话题词 + 大写代币 + 中文片段），
按命中打分排序；关键词无任何命中时回退全池（精选不空窗）但给条目打
fallback 标记（item.fallback 属性 + entities["fallback"]），不静默冒充命中。
条目 id 由 source+title 内容哈希决定，多次刷新不变。
实体抽取：优先用池内 entities，缺 token 时用 tools 的抽取逻辑从标题/摘要补。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from .domain import FeedItem
from .tools import DEFAULT_NEWS_POOL, _extract_token


def stable_item_id(source: str, title: str) -> str:
    """条目 id 由内容决定（source+title 的 sha1 前 32 位，与 uuid hex 同长）：
    同一条新闻多次刷新 id 不变，调度 event 触发的 seen 基线才不会被刷新打穿。"""
    return hashlib.sha1(f"{source}\n{title}".encode("utf-8")).hexdigest()[:32]

_TOPIC_WORDS = [
    "meme", "defi", "market", "aave", "solana", "ethereum", "bitcoin",
    "uniswap", "etf", "借贷", "利率", "治理", "投票", "流动性",
    "比特币", "以太坊", "新币", "大盘", "市场",
]
_STOP = {"我想看", "我想", "关注", "重点", "都看", "动态", "相关", "新闻", "每日"}


def _keywords(prompt_text: str) -> list[str]:
    text = prompt_text or ""
    lowered = text.lower()
    found: list[str] = []
    for word in _TOPIC_WORDS:
        if word in lowered and word not in found:
            found.append(word)
    for token in re.findall(r"\b[A-Z][A-Z0-9]{1,9}\b", text.upper()):
        if token not in ("USD",) and token.lower() not in found:
            found.append(token.lower())
    for chunk in re.findall(r"[一-鿿]{2,4}", text):
        if chunk not in _STOP and chunk not in found:
            found.append(chunk)
    return found


def extract_entities(item: dict[str, Any]) -> dict[str, Any]:
    """实体抽取：池内 entities 为主，缺 token 时从标题/摘要抽代币补齐。"""
    entities = dict(item.get("entities") or {})
    if not entities.get("token"):
        token = _extract_token(f"{item.get('title', '')} {item.get('summary', '')}")
        if token:
            entities["token"] = token
    if item.get("topic") and not entities.get("topic"):
        entities["topic"] = item["topic"]
    return entities


class SeedNews:
    """NewsSourcePort 实现：内置确定性新闻池。"""

    def __init__(self, pool: list[dict[str, Any]] | None = None):
        self._pool = list(pool) if pool is not None else list(DEFAULT_NEWS_POOL)

    @property
    def pool(self) -> list[dict[str, Any]]:
        return list(self._pool)

    def fetch(self, query: str = "", limit: int = 20) -> list[dict[str, Any]]:
        q = (query or "").lower()
        hits: list[dict[str, Any]] = []
        for item in self._pool:
            haystack = (
                f"{item.get('title', '')} {item.get('summary', '')} "
                f"{item.get('topic', '')}"
            ).lower()
            if not q or q in haystack:
                hits.append(dict(item))
        return hits[:limit]


class FeedGenerator:
    """按提示词生成 FeedItem 并落库（replace 本用户的精选列表）。"""

    def __init__(self, store: Any, news_source: SeedNews | None = None):
        self._store = store
        self._news = news_source or SeedNews()

    def generate(
        self, user_id: str, prompt_text: str, prompt_version: int | None = None
    ) -> list[FeedItem]:
        keywords = _keywords(prompt_text)
        scored: list[tuple[int, int, dict[str, Any]]] = []
        for idx, raw in enumerate(self._news.fetch("", limit=10_000)):
            haystack = (
                f"{raw.get('title', '')} {raw.get('summary', '')} "
                f"{raw.get('topic', '')} {raw.get('entities', {})}"
            ).lower()
            score = sum(1 for kw in keywords if kw in haystack)
            scored.append((score, idx, raw))
        # 零命中回退：提示词有关键词但一条都没命中 → 回退全池但必须打标，
        # 不许静默冒充命中（标记经 entities 落库并被 API feed_json 透出）。
        is_fallback = bool(keywords) and not any(s > 0 for s, _, _ in scored)
        if keywords and not is_fallback:
            scored = [entry for entry in scored if entry[0] > 0]
        scored.sort(key=lambda entry: (-entry[0], entry[1]))
        items: list[FeedItem] = []
        for rank, (_score, idx, raw) in enumerate(scored):
            source = str(raw.get("source", "SeedNews"))
            title = str(raw.get("title", ""))
            entities = extract_entities(raw)
            item = FeedItem(
                id=stable_item_id(source, title),
                user_id=user_id,
                title=title,
                summary=str(raw.get("summary", "")),
                source=source,
                url=str(raw.get("url", "")),
                topic=str(raw.get("topic", "")),
                entities=entities,
                # 无时间不编造：存 None，API 原样返回 null，前端显示「时间未知」。
                published_at=raw.get("published_at") or None,
                prompt_version=prompt_version,
            )
            if is_fallback:
                item.fallback = True  # type: ignore[attr-defined]
                entities["fallback"] = "未命中关注点"
            items.append(item)
        self._store.replace_feed_items(user_id, items)
        return items
