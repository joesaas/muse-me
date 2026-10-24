# 原子工具目录（与 tools.py 注册表一致，启动校验）
- market.quote | read | 查询标的现价
- meme.scan | read | 从新闻/代币抽实体并查流动性与风险
- dex.quote | read | DEX 报价（预计成交价/滑点）
- dex.sim_swap | write | 模拟兑换（Demo 只模拟）
- aave.rates | read | Aave 各资产利率
- aave.sim_supply | write | 模拟存入并测算收益
- news.search | read | 按关键词检索新闻池
- web.fetch | read | 抓取网页（Demo 桩，返回摘要占位）
- notify.send | write | 站内通知
