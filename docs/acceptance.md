# muse-me 验收记录（2026-10-24 凌晨，Muse 亲验）

验收方式：全量单测 + 评估用例 + 真实进程起服务后用 HTTP 走完整动线（非 Mock 假绿）。
环境：Python 3.12，`MUSE_ME_DB` 指向临时库，端口 8899，口令登录。

## 自动化证据

- `python3 -m unittest discover -s tests`：**48/48 通过**（核心 38 + 服务/API 10）。
- `python3 -m muse_me.evaluation`：**4/4 通过**。
- 前端 `tsc -p tsconfig.json`（strict）：**编译通过，0 错误**。

## 活体动线证据（真实服务）

1. 登录 200；今日精选返回 4 条，实体抽取正确（UNI/Uniswap/defi）。
2. 从精选建「构建脚本」新话题 → 发送「买这个 meme，100 美元，先查流动性」→ 聊天 Run done，脚本《新闻驱动 meme 买入》以**更新版本**方式保存（v2，无重复脚本条目）。
3. 脚本试运行：done。正式运行：scan（UNI 流动性 $7,551,709、风险 low）→ quote（滑点 0.101%）→ **停在审批 awaiting_approval**。
4. 在「待我确认」批准后：续跑 sim_swap → Run **done**；事件序列完整：plan_created → step_started → tool_called → step_done → approval_required → step_started → tool_called → step_done → run_done（执行记录可回放）。
5. Aave 收益脚本：rates → 审批 → sim_supply → done。
6. 提示词版本：PUT 改版 v1→v2，versions 列表 [1,2]，rollback 到 v1 生成 v3 且内容为 v1 原文。
7. 它记得的事：fact 已生效 1 条、inference 待批准 1 条（未批准不生效）。
8. 定时任务：种子任务「每小时看 Aave 收益」enabled，next_fire 在 +60 分钟。

## 对照报告验收清单（v1.2 Step 7）

| # | 条目 | 结果 |
|---|---|---|
| 1 | 主聊与旁聊并行、上下文不串扰 | ✓ 聊天/消息按 chat 隔离，存储与 API 冒烟覆盖 |
| 2 | 写操作被审批拦下、批准后执行、轨迹可回放 | ✓ 活体证据 3–4 |
| 3 | 改 Feed 提示词后内容随变、可回滚 | ✓ 活体证据 6（改版自动刷新精选；回滚生成新版本） |
| 4 | Feed 一键进旁聊、实体自动带入 | ✓ 活体证据 1–2 |
| 5 | 对话构建 meme 脚本、保存后改参重跑 | ✓ 构建与保存活体验证；改参重跑由引擎单测覆盖（params overrides） |
| 6 | Aave 脚本全流程（模拟） | ✓ 活体证据 5 |
| 7 | 脚本绑定时任务、失败重试留痕、敏感步转审批 | ✓ 评估例 04 + scheduler 单测（重试 3 次、JobRun 留痕、awaiting 转审批通知） |
| 8 | 推断记忆未批准不生效 | ✓ 评估例 03 + 活体证据 7 |
| 9 | 花费触顶自动停 | ✓ 核心单测：超硬顶落 run_failed(reason=budget) 并停 Run |
| 10 | AgentCore 同题跑通并写对比 | ✗ 未完成（如实）：AgentCore 为接口完整的桩（未配置返回 not_configured），真实跑通需 li 的 AWS 账号配置；对比文档已备（docs/runtime-comparison.md），价格为公开价目、未实测项已标注 |
| 11 | 全站界面只用小白名 | ✓ 前端菜单与文案逐项检查，无 Chat/Feed/Tool/Bot 英文技术词 |

## 亲验中发现并已修复的问题

1. **种子 meme 脚本无法独立运行**：token 默认 `${entity.token}` 但种子未带 entity，独立试运行必失败。已给种子补 entity（BONK，源自种子新闻池），且构建同名脚本改为更新版本（原实现每次构建都新建重复脚本）。
2. **Feed 提示词只有版本、没有回滚入口**：存储层保留全部版本但 API 未暴露。已补 GET versions + POST rollback，前端加「回到上一版」按钮，活体验证通过。
3. 首轮活体验证曾误连上一轮未退出的服务进程，导致结论污染；已确认原因（端口占用、旧进程未到期）后在干净环境重验，上述证据均为重验结果。
