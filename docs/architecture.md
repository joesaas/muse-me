# muse-me 架构设计（Architect 定版）

> 依据：《类 Muse 个人 Agent Demo · 项目报告 v1.2》。本文件是实现唯一依据；与报告冲突时先改报告再改本文件。
> 项目默认名 muse-me（li 未另定名时用此名，改名只需改包名与标题，不影响结构）。

## 1 设计原则（不可妥协）

1. **SOLID + 迪米特法则**，但防过度设计：只为已知变化方向留接口（运行时、模型、存储、原子工具四处），其余写直。
2. **六边形架构（端口与适配器）**：领域与应用服务不依赖 HTTP、SQLite、具体模型厂商；一切外部能力经 Port 接口注入。
3. **审批 fail-closed**：无审批人/审批超时/护栏文件缺失时，写操作与敏感步骤一律 DENY。
4. **文件为正本（Harness）**：原则、手册、护栏、场景、技能提示词以 git 管理的 Markdown 为正本；数据库只存运行数据与索引。
5. **轨迹即事实**：每一次运行（聊天轮次、脚本执行、定时任务）都产生结构化 Run + RunEvent，可回放、可评估；无轨迹不算执行。
6. **脚本只调用白名单原子工具**：不开放任意代码执行。脚本是数据（JSON 步骤），不是代码。
7. **密钥只存引用**：库中只存 `secrets_ref`，明文永不进对话、日志、轨迹。

## 2 系统分层

```
┌ Web 前端（Vue 3 + TypeScript SPA，六个小白菜单） ─ REST + SSE ─┐
├ API 层（http.server，路由/鉴权/SSE 事件流）        │
├ 应用服务层 AppServices                            │
│   ChatService / ScriptService / JobService        │
│   FeedService / ApprovalService / MemoryService   │
├ 领域层 Domain（纯数据与规则，无 I/O）               │
│   Chat, Message, Run, Approval, MemoryItem,       │
│   Script, ScriptVersion, Job, FeedItem, AtomicTool │
├ Harness 层                                        │
│   执行层：五原语 + Planner + Orchestrator          │
│   驾驭层：Loader / Assembler / Guardrails（读文件） │
│   评估层：Regression / Judge / IterationGate       │
├ 端口 Ports（Protocol 接口）                        │
│   RuntimePort / ModelPort / StorePort / ToolPort  │
│   ClockPort / SecretPort / NewsSourcePort         │
└ 适配器 Adapters                                   │
    LocalRuntime / AgentCoreRuntime(桩,同接口)       │
    MockModel / OpenRouterModel                     │
    SqliteStore / FileHarnessSource / SeedNews      │
    SchedulerDaemon（独立线程，调度 Bot 与 Feed）    │
```

依赖方向只向下：上层依赖 Port，不依赖具体 Adapter。Adapter 在 `bootstrap.py` 一处组装（组合根）。

## 3 运行时设计（Runtime Adapter）

`RuntimePort` 五法（与报告定版一致）：

```python
class RuntimePort(Protocol):
    def create_session(self, user_id: str, scene: str) -> Session: ...
    def invoke(self, session_id: str, prompt: str, ctx: dict) -> Iterator[RunEvent]: ...
    def cancel(self, run_id: str) -> bool: ...
    def get_trace(self, run_id: str) -> list[RunEvent]: ...
    def health(self) -> dict: ...
```

- `LocalRuntime`：进程内实现，调用 Orchestrator。第一实现，Demo 主力。
- `AgentCoreRuntime`：接口完整的桩实现——构造需配置（region/runtime_arn），未配置时 `health()` 返回 `not_configured`，`invoke` 抛 `RuntimeNotConfigured` 并给出配置指引。阶段 5 补真实传输后做同题对比（见 docs/runtime-comparison.md 模板）。

## 4 执行层（复用 ShadowClaw）

- 五原语：`sequence`（串行）、`route`（规则选路）、`parallel`（asyncio 并发、失败隔离）、`reflect`（清单检查、打回 ≤2）、`delegate`（独立 session 子代理，深度 ≤2）。
- Planner：先由规则 Planner 按场景生成 Plan（可审计数据）；配置了真实模型时可由模型改写 Plan，但必须过 Guardrails 校验后才执行。
- 状态：隔离副本 + 受控事实板（单写者），原语间不共享可变状态。
- 每步落 RunEvent：`plan_created / step_started / tool_called / approval_required / step_done / reflect_failed / run_done / run_failed`。

## 5 脚本引擎（我的脚本）

脚本 = JSON 文档：`{name, params:[{key,label,type,default}], steps:[{tool, args, save_as?}], requires_approval_before_step?: int}`。

- 构建：Chat 中由 ScriptService 把用户意图 + 上下文（可含 Feed 条目）拼成脚本草稿 → 沙箱试运行（原子工具走 simulate 模式）→ 用户确认 → 存 `scripts` + `script_versions`（每次修改新版本）。
- 执行：ScriptRunner 按步解释执行；每步过 Guardrails；标了审批的步骤前挂起 Run 为 `awaiting_approval`，审批通过后续跑。
- 原子工具注册表（ToolPort 实现，白名单）：`market.quote`、`dex.quote`、`dex.sim_swap`、`aave.rates`、`aave.sim_supply`、`news.search`、`web.fetch`（桩）、`notify.send`、`meme.scan`（从新闻抽代币+流动性/风险检查）。Demo 数据为确定性模拟数据源（seeded），接口形状对齐真实 API，便于后换真源。

## 6 调度引擎（定时任务 Bot）

- 独立线程 `SchedulerDaemon`，每秒 tick；不依赖任何聊天会话存活。
- 触发三类：`time`（cron 简式：每天 HH:MM / 每 N 分钟）、`event`（Feed 新条目关键词/赛道匹配）、`condition`（原子工具返回值与阈值比较，轮询）。
- Job 绑定 script_id + 参数；执行产生 Run（来源标记 job）；敏感步骤自动转审批并通知（站内通知表）。
- 失败重试：指数退避最多 3 次，job_runs 留痕；可暂停/恢复/改期。

## 7 Feed（今日精选）

- FeedService 按用户的 Feed 提示词（prompts 表，版本化）+ NewsSourcePort 生成条目。Demo 的 SeedNews 为内置新闻池（确定性），接口预留接 data-pipeline records API。
- 每条 FeedItem 带实体抽取（token/合约/赛道）；「基于此构建」= 以 feed_item_id 建新话题 Chat，首条系统上下文注入新闻全文与实体。

## 8 数据与存储

SQLite 单文件（`data/muse_me.db`），表见报告 Step 5 + `scripts/script_versions/triggers(notifications)`。StorePort 之下实现，领域层不见 SQL。迁移用 `schema.sql` + 版本号表，不引入 ORM。

## 9 安全与护栏

- Guardrails 从 `harness/guardrails/*.md` 的结构化区块读入：花费硬顶（每轮/每日 token 与模拟金额）、工具金额上限、风险分级表（read 自动 / write 攒批 / irreversible 单独确认）。
- 自建脚本沙箱 = 白名单 + 参数 schema 校验 + simulate 先行，三重。
- 登录：单账户口令（环境变量 `MUSE_ME_PASSWORD`，默认 demo 口令仅本地），会话 cookie；Demo 级别足够，文档明示非生产强度。

## 10 评估层

- 回归集：`evaluation/cases/*.json`（输入 + 期望命中点），离线跑 `python -m muse_me.evaluation` 出报告；Judge 可选（默认程序硬查，模型裁判权重默认 0，与 ShadowClaw 口径一致）。
- 迭代门：候选驾驭层变更须回归不退步才合入；本 Demo 实现门函数与报告生成，不做自动改写。

## 11 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 语言 | Python 3.12 标准库零依赖 | 与 muse-agent 先例一致；无安装风险；可维护 |
| Web | http.server 后端 + Vue 3 前端（Vite 构建，Pinia + Vue Router，hash 路由） | 前端与后端契约靠 types.ts 在编译期对齐（vue-tsc strict）；后端静态服务无 SPA fallback，故路由用 hash 模式、产物输出 web/ 由后端直读托管 |
| 存储 | sqlite3（标准库） | 单人 Demo 足够；StorePort 隔离可换 PG |
| 模型 | MockModel 默认；OpenRouterModel 可选（urllib） | 离线可演示；真模型一键切换 |
| 测试 | unittest（标准库） | 零依赖；`python -m unittest discover` |

## 增补（2026-10-24）：控制面一级包 server/（Fastify + TypeScript）

按 li 定版，控制面从 Python 包中独立为与 `src/`、`frontend/` 平级的一级包 `server/`：

- **分工**：`server/`（TS/Fastify）是控制面——给前端提供 API + 操作管理 AWS AgentCore（运行时资源 CRUD、带会话调用与事件流转发），并持有应用状态（聊天/脚本/任务/审批）与调度；`src/muse_me`（Python）是被 AgentCore 托管的 Agent 本体（执行层 + Harness + 工具），对外满足 AgentCore HTTP 契约。拆分动因：AgentCore 会话跑在临时 microVM（单会话上限约 8 小时、文件系统不持久），状态与 Bot 调度不能放进运行时。
- **分层（六大原则落位）**：`domain/`（领域类型 + 按聚合拆分的小端口接口 + RuntimePort 五法）、`application/`（用例服务，只依赖端口）、`infrastructure/`（node:sqlite 存储、LocalRuntime、AgentCore 运行时与管理客户端）、`api/`（薄控制器，入参严校验，序列化单点收口）；`app.ts` 为唯一组合根。换运行时实现只改组合根（开闭/里氏），存储接口按聚合隔离（接口隔离），框架与 SDK 不渗透应用层（依赖倒置/迪米特）。
- **范围（第二期已完成）**：全部路由已迁移（feed/prompts/scripts/jobs+进程内调度/memories/files/settings），server 同源托管前端 `web/`，前端已切换指向 server；待审批计划快照落库，控制面重启可续跑。AgentCore 客户端为真实现但未做真实 AWS 联调（需 li 的 AWS 账号配置），未配置时健康口径明示 not_configured。
- **Agent 侧入口（2026-10-24 补齐）**：`src/muse_me/agentcore_app.py`——官方 SDK `bedrock-agentcore` 的 `BedrockAgentCoreApp` 入口（8080、/ping、/invocations），只做 SDK 入口 + 组装现有组件（llm 模型 / Orchestrator / ToolRegistry / harness 护栏），事件以 `{"type","payload"}` 逐条 yield、与本地运行时同形；审批挂起态以控制面 runtimeSessionId（SDK 的 context.session_id）为键存进程内字典（同会话同 microVM 的平台语义），resume 校验 approvedStep 后以 Orchestrator resume 语义续跑，挂起态丢失时如实 run_failed。SDK 为可选依赖（pyproject extra `agentcore` / requirements-agentcore.txt），主包仍零依赖；打包脚本 `scripts/package_agentcore.sh` 产出直接代码部署 zip（arm64 依赖）。本地 8080 契约已实测三段（新调用停审批 / resume 到 run_done / 无挂起态如实失败）；真实 AWS 部署与联调仍待 li 账号（验收第 10 条）。
