# muse-me 细节设计

## 1 模块清单（src/muse_me/）

| 模块 | 职责 | 关键类型/函数 |
|---|---|---|
| `domain.py` | 纯领域对象与枚举 | dataclasses: Chat, Message, Run, RunEvent, Approval, MemoryItem, Script, ScriptVersion, Job, JobRun, FeedItem, Notification, PromptDoc |
| `ports.py` | 全部 Port 的 Protocol 定义 | RuntimePort, ModelPort, StorePort, ToolRegistryPort, NewsSourcePort, ClockPort |
| `errors.py` | 异常收敛 | DemoError 基类 + NotFound/PermissionDenied/GuardrailDenied/RuntimeNotConfigured |
| `storage.py` | SqliteStore（StorePort 实现）+ schema | `init_schema(conn)`, 各 repo 方法按聚合分段 |
| `harness_files.py` | 驾驭层文件读取：原则/手册/护栏/场景 | `load_guardrails() -> GuardrailPolicy`, `assemble_context(scene) -> str`，含 harness 版本号（文件哈希聚合，含手册） |
| `llm.py` | MockModel（确定性脚本化回复与计划）/ OpenRouterModel | `complete(messages) -> str`, `plan(scene, goal) -> Plan` |
| `execution.py` | 五原语 + Orchestrator + FactBoard | `run_plan(plan, ctx) -> Iterator[RunEvent]` |
| `tools.py` | 原子工具注册表（白名单、参数 schema、风险级、模拟数据源） | `TOOLS: dict[str, AtomicTool]`, `call(name, args, mode)` |
| `scripts_engine.py` | 脚本构建/校验/试运行/执行/版本 | `build_draft(intent, feed_item=None)`, `validate_script(doc)`, `run_script(...)` |
| `feed.py` | Feed 生成 + 实体抽取 | `generate(user_prompt) -> list[FeedItem]`, SeedNews |
| `scheduler.py` | 调度守护线程：三类触发、重试、通知 | `SchedulerDaemon.tick()`, `next_fire(job, now)` |
| `services.py` | 应用服务（组合以上，对 API 层提供粗粒度用例） | ChatService, ApprovalService, ScriptService, JobService, FeedService, MemoryService |
| `runtime.py` | LocalRuntime / AgentCoreRuntime 桩 | 见架构 §3 五法 |
| `evaluation.py` | 回归集 runner + 门函数 | `run_cases(cases_dir) -> Report`, `gate(baseline, candidate) -> bool` |
| `api.py` | HTTP 路由 + SSE + 静态文件 | 路由表见 §3 |
| `bootstrap.py` | 组合根：装配 store/harness/llm/runtime/services/scheduler | `create_app(config) -> App` |
| `__main__.py` | `python -m muse_me` 起服务（默认 127.0.0.1:8765） | 读环境变量配置 |
| `seed.py` | 演示种子：新闻池、示例脚本（meme 买入、Aave 收益）、示例定时任务、记忆种子 | `seed_if_empty(store)` |

## 2 领域不变量

- Run 状态机：`running → awaiting_approval → running → done|failed|cancelled`；终态不可再迁移（代码以集合校验，非法迁移抛 DemoError）。
- Approval 只能由 pending → approved|denied 一次；审批对象引用 (run_id, step_index)。
- Script 每次保存生成新 ScriptVersion（版本号递增）；Job 绑定 script 时钉住「当前版本或指定版本」二选一，默认当前版本并在 job_runs 记录实际版本。
- MemoryItem 分级：`fact`（可自动入）/`inference`（须先入 pending 区，批准后生效）/`never`（拒绝入库）；分類拿不准归 inference。
- 花费记账：每个 RunEvent 若含 usage 则累加到 run.cost；超 GuardrailPolicy 硬顶时 Orchestrator 立即停 Run 并落 `run_failed(reason=budget)`。

## 3 API 路由（JSON；SSE 单列）

| 方法 路径 | 用例 |
|---|---|
| POST /api/login | 口令登录发 cookie |
| GET /api/chats · POST /api/chats | 列表 / 新建（可带 feed_item_id 建「新话题」） |
| GET /api/chats/{id}/messages | 历史 |
| POST /api/chats/{id}/send | 发消息 → 返回 run_id（事件走 SSE） |
| GET /api/events?run_id= | SSE：转发该 Run 的 RunEvent |
| GET /api/approvals · POST /api/approvals/{id}/decide | 待我确认队列 / 批或拒 |
| GET /api/feed · POST /api/feed/refresh | 今日精选 / 按当前提示词刷新 |
| GET/PUT /api/prompts/feed | 「我想看什么」读写（PUT 产生新版本） |
| GET /api/scripts · POST /api/scripts/build | 我的脚本列表 / 对话构建草稿（body: chat_id 或 intent+feed_item_id） |
| POST /api/scripts/{id}/trial · POST /api/scripts/{id}/run | 沙箱试运行 / 正式运行（可传参） |
| GET /api/jobs · POST /api/jobs · POST /api/jobs/{id}/toggle | 定时任务 CRUD/暂停恢复 |
| GET /api/runs · GET /api/runs/{id} | 执行记录与回放（事件全量） |
| GET /api/memories · POST /api/memories/{id}/decide · DELETE /api/memories/{id} | 它记得的事（含待批准区） |
| GET /api/settings/connections | 账号与连接（只读状态 + secrets 引用名，不回明文） |
| GET /api/files | 我的文件（产物：脚本导出、运行报告，Demo 为库内清单） |

## 4 前端（web/）

源码在 `frontend/src/`（TypeScript，strict）：`types.ts` 是与 Python API 的契约（字段与后端 JSON 一一对应，后端改字段必须同步改此文件，由 tsc 拦截不一致）、`app.ts` 为逻辑（事件委托绑定，不用内联 onclick）。构建只有一步 `npm run build`（tsc），输出到 `web/`（index.html/style.css 为静态文件，app.js 为编译产物，不手改）。页面左侧一级菜单六个（聊天、今日精选、我的脚本、定时任务、待我确认[角标]、我的文件），「更多」收执行记录、它记得的事、账号与连接。无框架；fetch + EventSource。

每页最小功能：
- 聊天：会话列表（主聊/新话题徽标）、消息流、流式渲染、运行中可停、工具调用折叠卡。
- 今日精选：条目卡（标题/摘要/实体标签/来源时间），按钮：追问（建新话题）、基于此构建脚本。
- 我的脚本：脚本卡列表（名/参数/版本），试运行、运行（参数弹窗）、改脚本（回聊天构建新版本）、绑为定时任务。
- 定时任务：任务表（触发类型/下次执行/状态/最近结果），新建（选脚本+触发）、暂停/恢复。
- 待我确认：审批卡（动作说明/金额/风险级），批准/拒绝（可填理由）。
- 我的文件：产物清单（脚本 JSON 导出、评估报告）可下载。

## 5 Harness 文件（harness/ 为正本）

- `principles/core.md`：决策原则（复用 ShadowClaw 定版 17 条的 Demo 子集，逐条一行）。
- `playbooks/troubleshooting.md`、`playbooks/script-building.md`：方法手册（脚本构建手册为本项目新写：抽实体→查风险→报价→模拟→审批→保存六步）。
- `guardrails/policy.md`：结构化区块（YAML 风格键值）：花费硬顶、金额上限、风险分级表、审批规则。
- `scenarios/*.md`：场景组装清单（chat / script_build / feed_brief 三场景，各列引用哪些原则/手册/工具）。
- `memory/`：记忆文件镜像（库为运行正本，文件为种子来源，文档明示口径）。
- `tools/catalog.md`：原子工具目录（与 tools.py 注册表一一对应，装配时校验一致，不一致启动失败）。

## 6 脚本 DSL 示例（meme 买入，种子脚本）

```json
{
  "name": "新闻驱动 meme 买入",
  "params": [
    {"key": "amount_usd", "label": "买入金额（美元）", "type": "number", "default": 100},
    {"key": "token", "label": "代币", "type": "string", "default": "${entity.token}"}
  ],
  "steps": [
    {"tool": "meme.scan", "args": {"token": "${token}"}, "save_as": "scan"},
    {"tool": "dex.quote", "args": {"token": "${token}", "amount_usd": "${amount_usd}"}, "save_as": "quote"}
  ],
  "requires_approval_before_step": 2,
  "final_step": {"tool": "dex.sim_swap", "args": {"token": "${token}", "amount_usd": "${amount_usd}"}}
}
```

插值只允许 `${param}` 与 `${step.field}` 两类，校验器拒绝其余表达式——这是沙箱的一部分。

## 7 评估用例（evaluation/cases/）

至少 4 例：①新闻构建脚本命中六步；②超金额被护栏拦；③推断记忆未批准不生效；④定时任务到点执行且敏感步转审批。每例含输入、期望事件序列子集、期望终态。
