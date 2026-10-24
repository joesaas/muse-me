# muse-me 任务拆分（WBS）

按依赖顺序执行；每项含出口标准。对应项目报告 Step 6 六阶段。

## 阶段 0 立项与骨架
- T0.1 仓库骨架：pyproject/README/.gitignore/docs 三件套（架构/细节/拆分）→ 标准：目录与文档就位。
- T0.2 Harness 正本文件：principles/playbooks/guardrails/scenarios/tools catalog/memory 种子 → 标准：harness_files 可读且版本号可算。

## 阶段 1 骨架闭环
- T1.1 domain + errors + ports → 标准：类型与接口齐，无 I/O。
- T1.2 storage（SQLite schema + repo） → 标准：建库、CRUD 单测过。
- T1.3 llm（Mock 先行，OpenRouter 后置同接口） → 标准：Mock 确定性回复/计划单测过。
- T1.4 execution 五原语 + Orchestrator + FactBoard → 标准：串行/路由/并行/反思/委派各一个单测；事件序列完整。
- T1.5 runtime（Local 五法；AgentCore 桩） → 标准：桩未配置时行为符合细节设计。
- T1.6 services + api + 前端聊天页 → 标准：浏览器可对话（Mock），轨迹落库，SSE 可见。

## 阶段 2 安全闭环
- T2.1 Guardrails 装配 + 花费记账 + 风险分级 → 标准：超限用例被拦（评估例 ②）。
- T2.2 审批服务 + 待我确认页 → 标准：写操作挂起→批准续跑→拒绝终止，全程事件齐。
- T2.3 记忆服务（分级/待批准区）+ 它记得的事页 → 标准：评估例 ③ 过。
- T2.4 技能与提示词管理（Feed 提示词版本） → 标准：改词产生新版本且可回滚。

## 阶段 3 特色链路
- T3.1 Feed 服务 + SeedNews + 今日精选页 → 标准：按提示词刷新出条目，实体标签齐。
- T3.2 「基于此构建」：Feed→新话题注入上下文 → 标准：新话题首轮即知新闻实体。
- T3.3 调度引擎（三触发/重试/通知）+ 定时任务页 → 标准：评估例 ④ 过；时间触发到点执行。

## 阶段 4 脚本工坊
- T4.1 原子工具注册表（9 个）+ catalog 一致性校验 → 标准：启动自检过；每工具 simulate 模式单测。
- T4.2 脚本引擎：构建草稿/校验/试运行/版本/执行 → 标准：DSL 插值与白名单校验单测过。
- T4.3 种子脚本（meme 买入、Aave 收益）+ 我的脚本页 → 标准：旗舰动线端到端演示通过（验收清单对应项）。

## 阶段 5 评估与对比
- T5.1 evaluation runner + 4 用例 + 门函数 → 标准：一键出报告，四例全过。
- T5.2 runtime-comparison.md：本地运行时实测（冷启动/单轮时延/零成本）与 AgentCore 公开价目对照（标注来源与未实测项） → 标准：文档齐，未实测不写成实测。
- T5.3 我的文件页（产物清单/下载）+ 账号与连接页 → 标准：两页可用。
- T5.4 全量验收：报告 Step 7 清单逐项核对并记录结果 → 标准：验收记录写入 docs/acceptance.md。
