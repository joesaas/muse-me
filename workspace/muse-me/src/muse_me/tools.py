"""原子工具注册表（白名单）：9 个工具，全部为确定性模拟数据源（seeded）。

- 数据口径：已知 token 用内置价格表；其余 token 按符号哈希生成稳定伪价格，
  同一输入永远同一输出（无随机、无网络），便于单测与演示复现。
- mode="simulate"（默认）只模拟；写工具在 mode="live" 下一律 GuardrailDenied
  （Demo 不动真实资产，见架构 §5）。
- news.search 的新闻池可从外部注入（ToolRegistry(news_pool=...) 或 set_news_pool），
  默认内置 6 条种子新闻。
- notify.send 的投递回调可注入（ToolRegistry(notify_sink=...)），无回调时记入
  注册表内部 outbox 并返回 delivered="local"。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Callable

from .domain import AtomicTool
from .errors import GuardrailDenied, NotFound

ToolFunc = Callable[[dict[str, Any], str], dict[str, Any]]


def _hash_int(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:12], 16)


# 已知标的价格表（模拟数据，仅 Demo 用）
KNOWN_PRICES: dict[str, float] = {
    "BTC": 97400.0,
    "ETH": 3420.0,
    "SOL": 214.5,
    "USDC": 1.0,
    "USDT": 1.0,
    "DAI": 1.0,
    "AAVE": 365.0,
    "UNI": 13.8,
    "DOGE": 0.32,
    "WIF": 2.14,
    "PEPE": 0.0000182,
    "BONK": 0.0000321,
}

STABLECOINS = {"USDC", "USDT", "DAI"}

AAVE_RATES: dict[str, dict[str, float]] = {
    "USDC": {"supply_apy": 4.62, "borrow_apy": 6.10},
    "USDT": {"supply_apy": 4.35, "borrow_apy": 5.88},
    "DAI": {"supply_apy": 4.10, "borrow_apy": 5.65},
    "ETH": {"supply_apy": 2.85, "borrow_apy": 3.40},
    "WBTC": {"supply_apy": 1.92, "borrow_apy": 2.55},
    "AAVE": {"supply_apy": 0.0, "borrow_apy": 4.20},
}

DEFAULT_NEWS_POOL: list[dict[str, Any]] = [
    {
        "title": "Solana 生态 meme 币 BONK 单日交易量创新高",
        "summary": "BONK 流动性池深度一周内翻倍，社区热度持续升温。",
        "source": "SeedNews",
        "topic": "meme",
        "entities": {"token": "BONK", "chain": "solana"},
    },
    {
        "title": "Aave V4 提案进入治理投票，利率模型将升级",
        "summary": "提案拟优化 USDC 与 ETH 借贷利率曲线，预计提升资金利用率。",
        "source": "SeedNews",
        "topic": "defi",
        "entities": {"protocol": "Aave", "token": "AAVE"},
    },
    {
        "title": "以太坊现货 ETF 连续五日净流入",
        "summary": "机构资金持续流入，ETH 价格站稳 3400 美元上方。",
        "source": "SeedNews",
        "topic": "market",
        "entities": {"token": "ETH"},
    },
    {
        "title": "某新发 meme 币 PEPE2 上线后流动性迅速枯竭",
        "summary": "PEPE2 上线两小时后池深度不足一万美元，多名买家无法卖出。",
        "source": "SeedNews",
        "topic": "meme",
        "entities": {"token": "PEPE2", "chain": "ethereum"},
    },
    {
        "title": "Uniswap 推出聚合器 Hooks，DEX 报价竞争加剧",
        "summary": "新 Hooks 机制允许第三方为兑换路径提供更优报价。",
        "source": "SeedNews",
        "topic": "defi",
        "entities": {"protocol": "Uniswap", "token": "UNI"},
    },
    {
        "title": "比特币突破 97000 美元，衍生品资金费率温和",
        "summary": "BTC 创阶段新高，永续资金费率保持中性，现货买盘为主。",
        "source": "SeedNews",
        "topic": "market",
        "entities": {"token": "BTC"},
    },
]


def pseudo_price(symbol: str) -> float:
    """未知 token 的稳定伪价格：由符号哈希决定，落在 0.0001–50 美元区间。"""
    h = _hash_int(f"price:{symbol.upper()}")
    return round(0.0001 + (h % 500_000) / 10_000.0, 8)


def price_of(symbol: str) -> float:
    symbol = symbol.upper()
    return KNOWN_PRICES.get(symbol, pseudo_price(symbol))


def liquidity_of(symbol: str) -> float:
    """确定性流动性（美元）：稳定币/主流币深，新 meme 浅。"""
    symbol = symbol.upper()
    if symbol in STABLECOINS:
        return 500_000_000.0
    if symbol in ("BTC", "ETH"):
        return 250_000_000.0
    if symbol in KNOWN_PRICES:
        return float(2_000_000 + _hash_int(f"liq:{symbol}") % 18_000_000)
    return float(5_000 + _hash_int(f"liq:{symbol}") % 95_000)


# ---------------- 各工具实现 ----------------

def _market_quote(args: dict[str, Any], mode: str) -> dict[str, Any]:
    symbol = str(args.get("symbol") or args.get("token") or "").upper()
    if not symbol:
        raise GuardrailDenied("market.quote 缺少 symbol 参数")
    price = price_of(symbol)
    change = round((_hash_int(f"chg:{symbol}") % 2000) / 100.0 - 10.0, 2)
    return {
        "symbol": symbol,
        "price_usd": price,
        "change_24h_pct": change,
        "source": "simulated",
        "cost_usd": 0.001,
    }


def _extract_token(text: str) -> str | None:
    """从文本中抽取最像 meme 标的的大写代币符号。"""
    candidates = re.findall(r"\b[A-Z][A-Z0-9]{1,9}\b", text.upper())
    for cand in candidates:
        if cand in KNOWN_PRICES or cand.endswith("2") or len(cand) >= 3:
            if cand not in ("USD", "APY", "DEX", "ETF"):
                return cand
    return candidates[0] if candidates else None


def _meme_scan(args: dict[str, Any], mode: str) -> dict[str, Any]:
    token = str(args.get("token") or "").upper() or _extract_token(
        str(args.get("text") or args.get("news") or "")
    )
    if not token:
        raise GuardrailDenied("meme.scan 无法从输入中抽取代币")
    liquidity = liquidity_of(token)
    h = _hash_int(f"risk:{token}")
    holders = 200 + h % 50_000
    if liquidity >= 5_000_000:
        risk = "low"
    elif liquidity >= 500_000:
        risk = "medium"
    else:
        risk = "high"
    warnings: list[str] = []
    if risk == "high":
        warnings.append("流动性不足 50 万美元，滑点与无法卖出风险高")
    if token not in KNOWN_PRICES:
        warnings.append("非主流标的，价格为模拟估值，务必小额")
    return {
        "token": token,
        "price_usd": price_of(token),
        "liquidity_usd": liquidity,
        "holders": holders,
        "risk_level": risk,
        "warnings": warnings,
        "source": "simulated",
        "cost_usd": 0.002,
    }


def _dex_quote(args: dict[str, Any], mode: str) -> dict[str, Any]:
    token = str(args.get("token") or args.get("symbol") or "").upper()
    amount = float(args.get("amount_usd") or 0)
    if not token or amount <= 0:
        raise GuardrailDenied("dex.quote 需要 token 与正数 amount_usd")
    price = price_of(token)
    liquidity = liquidity_of(token)
    slippage_pct = round(min(15.0, (amount / max(liquidity, 1.0)) * 100.0 + 0.1), 3)
    effective_price = price * (1 - slippage_pct / 100.0)
    return {
        "token": token,
        "amount_usd": amount,
        "price_usd": price,
        "effective_price_usd": round(effective_price, 8),
        "est_received": round(amount / effective_price, 6) if effective_price else 0,
        "slippage_pct": slippage_pct,
        "fee_usd": round(amount * 0.003, 4),
        "source": "simulated",
        "cost_usd": 0.002,
    }


def _dex_sim_swap(args: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode == "live":
        raise GuardrailDenied("Demo 只做模拟成交，dex.sim_swap 不执行真实兑换")
    quote = _dex_quote(args, mode)
    token = quote["token"]
    return {
        "status": "simulated",
        "token": token,
        "amount_usd": quote["amount_usd"],
        "received": quote["est_received"],
        "price_usd": quote["effective_price_usd"],
        "sim_tx": "SIM-" + hashlib.sha256(
            f"swap:{token}:{quote['amount_usd']}".encode()
        ).hexdigest()[:16],
        "note": "模拟成交，未动真实资产",
        "cost_usd": 0.003,
    }


def _aave_rates(args: dict[str, Any], mode: str) -> dict[str, Any]:
    asset = str(args.get("asset") or "").upper()
    if asset:
        if asset not in AAVE_RATES:
            raise NotFound(f"Aave 未收录资产：{asset}")
        return {"asset": asset, **AAVE_RATES[asset], "source": "simulated",
                "cost_usd": 0.001}
    return {
        "assets": [
            {"asset": name, **rates} for name, rates in sorted(AAVE_RATES.items())
        ],
        "source": "simulated",
        "cost_usd": 0.001,
    }


def _aave_sim_supply(args: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode == "live":
        raise GuardrailDenied("Demo 只做模拟存入，aave.sim_supply 不动真实资产")
    asset = str(args.get("asset") or "USDC").upper()
    amount = float(args.get("amount_usd") or args.get("amount") or 0)
    if asset not in AAVE_RATES:
        raise NotFound(f"Aave 未收录资产：{asset}")
    if amount <= 0:
        raise GuardrailDenied("aave.sim_supply 需要正数金额")
    apy = AAVE_RATES[asset]["supply_apy"]
    days = int(args.get("days") or 365)
    earnings = round(amount * apy / 100.0 * days / 365.0, 4)
    return {
        "status": "simulated",
        "asset": asset,
        "amount_usd": amount,
        "supply_apy": apy,
        "days": days,
        "est_earnings_usd": earnings,
        "est_total_usd": round(amount + earnings, 4),
        "note": "模拟存入测算，未动真实资产",
        "cost_usd": 0.002,
    }


def _news_search_impl(pool: list[dict[str, Any]]) -> ToolFunc:
    def _search(args: dict[str, Any], mode: str) -> dict[str, Any]:
        query = str(args.get("query") or args.get("keyword") or "").lower()
        limit = int(args.get("limit") or 5)
        hits = []
        for item in pool:
            haystack = (
                item.get("title", "") + " " + item.get("summary", "")
                + " " + item.get("topic", "")
            ).lower()
            if not query or query in haystack:
                hits.append(item)
        return {"query": query, "count": len(hits[:limit]), "items": hits[:limit],
                "cost_usd": 0.001}

    return _search


def _web_fetch(args: dict[str, Any], mode: str) -> dict[str, Any]:
    url = str(args.get("url") or "")
    if not url:
        raise GuardrailDenied("web.fetch 缺少 url 参数")
    return {
        "url": url,
        "status": "stub",
        "title": "",
        "summary": "（Demo 桩）web.fetch 未真实抓取，仅回占位摘要。",
        "cost_usd": 0.0,
    }


def _notify_impl(sink: Callable[[dict[str, Any]], None] | None, outbox: list) -> ToolFunc:
    def _send(args: dict[str, Any], mode: str) -> dict[str, Any]:
        if mode == "live":
            raise GuardrailDenied("Demo 的 notify.send 只写站内通知（simulate/local）")
        note = {
            "title": str(args.get("title") or "通知"),
            "body": str(args.get("body") or ""),
            "kind": str(args.get("kind") or "info"),
        }
        if sink is not None:
            sink(note)
            delivered = "callback"
        else:
            outbox.append(note)
            delivered = "local"
        return {"delivered": delivered, **note, "cost_usd": 0.0}

    return _send


_TOOL_DEFS: list[tuple[str, str, str, dict[str, Any]]] = [
    ("market.quote", "read", "查询标的现价", {"symbol": "string"}),
    ("meme.scan", "read", "从新闻/代币抽实体并查流动性与风险",
     {"token": "string?", "text": "string?"}),
    ("dex.quote", "read", "DEX 报价（预计成交价/滑点）",
     {"token": "string", "amount_usd": "number"}),
    ("dex.sim_swap", "write", "模拟兑换（Demo 只模拟）",
     {"token": "string", "amount_usd": "number"}),
    ("aave.rates", "read", "Aave 各资产利率", {"asset": "string?"}),
    ("aave.sim_supply", "write", "模拟存入并测算收益",
     {"asset": "string", "amount_usd": "number", "days": "number?"}),
    ("news.search", "read", "按关键词检索新闻池", {"query": "string"}),
    ("web.fetch", "read", "抓取网页（Demo 桩，返回摘要占位）", {"url": "string"}),
    ("notify.send", "write", "站内通知", {"title": "string", "body": "string"}),
]


class ToolRegistry:
    """ToolPort 实现：白名单注册表 + 确定性模拟实现。"""

    def __init__(
        self,
        news_pool: list[dict[str, Any]] | None = None,
        notify_sink: Callable[[dict[str, Any]], None] | None = None,
    ):
        self.news_pool = list(news_pool) if news_pool is not None else list(DEFAULT_NEWS_POOL)
        self.outbox: list[dict[str, Any]] = []
        impls: dict[str, ToolFunc] = {
            "market.quote": _market_quote,
            "meme.scan": _meme_scan,
            "dex.quote": _dex_quote,
            "dex.sim_swap": _dex_sim_swap,
            "aave.rates": _aave_rates,
            "aave.sim_supply": _aave_sim_supply,
            "news.search": _news_search_impl(self.news_pool),
            "web.fetch": _web_fetch,
            "notify.send": _notify_impl(notify_sink, self.outbox),
        }
        self._tools: dict[str, tuple[AtomicTool, ToolFunc]] = {
            name: (
                AtomicTool(name=name, risk=risk, description=desc, params=params),
                impls[name],
            )
            for name, risk, desc, params in _TOOL_DEFS
        }

    # ---- Port ----
    def list_tools(self) -> list[dict[str, Any]]:
        return [
            {"name": t.name, "risk": t.risk, "description": t.description,
             "params": t.params}
            for t, _ in self._tools.values()
        ]

    def get_tool(self, name: str) -> AtomicTool | None:
        entry = self._tools.get(name)
        return entry[0] if entry else None

    def call(
        self, name: str, args: dict[str, Any] | None = None, mode: str = "simulate"
    ) -> dict[str, Any]:
        entry = self._tools.get(name)
        if entry is None:
            raise NotFound(f"工具不在白名单：{name}")
        return entry[1](dict(args or {}), mode)


# 默认注册表（模块级 TOOLS 与便捷 call，签名与细节设计一致）
_default_registry = ToolRegistry()
TOOLS: dict[str, AtomicTool] = {
    name: tool for name, (tool, _) in _default_registry._tools.items()
}


def call(name: str, args: dict[str, Any] | None = None, mode: str = "simulate") -> dict[str, Any]:
    return _default_registry.call(name, args, mode)


def set_news_pool(pool: list[dict[str, Any]]) -> ToolRegistry:
    """替换默认注册表的新闻池（外部注入），返回新默认注册表。"""
    global _default_registry, TOOLS
    _default_registry = ToolRegistry(news_pool=pool)
    TOOLS = {name: tool for name, (tool, _) in _default_registry._tools.items()}
    return _default_registry


def set_notify_sink(sink: Callable[[dict[str, Any]], None]) -> ToolRegistry:
    global _default_registry, TOOLS
    _default_registry = ToolRegistry(
        news_pool=_default_registry.news_pool, notify_sink=sink
    )
    TOOLS = {name: tool for name, (tool, _) in _default_registry._tools.items()}
    return _default_registry


def validate_catalog(catalog_text: str) -> bool:
    """校验 harness/tools/catalog.md 与注册表一致：名称集合与风险级逐项相等。"""
    found: dict[str, str] = {}
    for line in catalog_text.splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        parts = [p.strip() for p in line[2:].split("|")]
        if len(parts) >= 2:
            found[parts[0]] = parts[1]
    expected = {name: tool.risk for name, tool in TOOLS.items()}
    return found == expected
