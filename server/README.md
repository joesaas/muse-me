# muse-me-server（控制面后端）

MuseMe 的**控制面**：给 Vue 前端提供 API，并操作管理 AWS Bedrock AgentCore 上的 Agent 运行时。
Agent 本体（执行层 / Harness / 原子工具）在 Python 包 `../src/muse_me`，本包与它只通过
RuntimePort 接口与 HTTP 契约对话，互不引用实现。

为什么拆：AgentCore 的会话跑在独立 microVM、文件系统临时、单会话上限约 8 小时——
聊天/脚本/任务/审批等**状态与调度存不住在 AgentCore 里**，天然属于控制面；
AgentCore 里只放无状态的「一次运行」。本包就是控制面的第一期实现。

## 技术选型

- Fastify 5 + TypeScript（strict）——Fastify 只做 HTTP 框架，业务不在路由回调里；
- 存储：Node 内置 `node:sqlite`（Node ≥22），不引原生依赖，数据在 `data/server.db`；
- AWS：官方 SDK v3 —— `client-bedrock-agentcore`（调用）+ `client-bedrock-agentcore-control`（资源管理）；
- 测试：vitest（含 handler 级 `app.inject`）。

## 六大设计原则在本包的落位

| 原则 | 落位 |
|---|---|
| 单一职责 | 每层每文件一职：`api/*` 只做入参校验/序列化，`application/*` 只做用例编排，`domain/*` 纯类型与状态机规则，`infrastructure/*` 一文件一适配器（三家 SQLite Store、两个 Runtime、一个 Admin 各一份） |
| 开闭 | 新运行时 = 新增一个 `RuntimePort` 实现并在组合根切换 `SERVER_RUNTIME`，不改应用层；新工具风险只改 `domain/types.ts` 的 `TOOL_RISKS` 数据表；新路由 = 新增 `*.routes.ts` 注册函数 |
| 里氏替换 | `LocalRuntime` 与 `AgentCoreRuntime` 同实现 `RuntimePort` 五法，应用层无差别使用；两个实现的未配置/取消等边缘口径一致（cancel→false、trace 从控制面库取） |
| 接口隔离 | 存储按聚合拆 `ChatStore` / `RunStore` / `ApprovalStore` / `SessionStore` 四个小接口——吸取 Python 版 StorePort 47 方法巨接口漂移的教训；`AgentCorePort` 与 `RuntimePort` 分开，管理面与调用面不混 |
| 依赖倒置 | `application/*` 与 `api/*` 只 import `domain/ports.ts` 的接口；具体类（SQLite、SDK、Fastify）只在 `app.ts` 组合根相遇；回复生成函数以参数注入 ChatService |
| 迪米特 | 控制器只认识 service 的方法、service 只认识端口方法；序列化集中在 `api/serializers.ts` 一处收口，前端契约字段（snake_case）不渗透进领域层（内部 camelCase） |

依赖方向只向内：`api -> application -> domain <- infrastructure`，组合根 `src/app.ts` 是唯一装配点。

## 目录

```
src/
  main.ts          入口：读配置 -> 启动守卫 -> buildApp -> listen（永不打印口令）
  config.ts        env 解析与校验（非法值报错，不静默降级）+ 非回环/默认口令守卫
  app.ts           组合根 buildApp
  domain/          types.ts（领域类型 + 工具风险表）/ ports.ts（小接口群）/
                   errors.ts（AppError 族 + httpStatus）/ run-state.ts（Run 状态机）
  application/     auth / chat / approval / agent-admin 四个用例服务
  infrastructure/  sqlite/（连接 + 三家 Store）/ auth/（内存会话）/
                   runtime/（local 确定性模拟运行时 / agentcore SDK 运行时 / 模拟计划器）/
                   agentcore/（控制面 SDK 封装）
  api/             routes 汇总、薄控制器、serializers、auth-guard、sse（/api/events）
tests/             vitest：config 守卫 / 审批与运行时链路 / handler 级校验 / AgentCore 未配置口径
```

## 本期 API 子集（字段与 Python 版契约一致）

- `POST /api/login`（口令换 `muse_session` cookie，HttpOnly；其余 /api/* 无 cookie 一律 401）
- `GET|POST /api/chats`、`GET /api/chats/:id/messages`、`POST /api/chats/:id/send` -> `{run_id}`
- `GET /api/events?run_id=&after=`（SSE 按 seq 增量、支持续传、终态/awaiting 关流、15s 心跳）
- `GET /api/approvals`、`POST /api/approvals/:id/decide`（`approved` 必须为 JSON 布尔，非布尔 400）
- `GET /api/runs`、`GET /api/runs/:id`（带事件回放）、`POST /api/runs/:id/cancel`
- `GET /api/agent/health`、`GET|POST /api/agent/runtimes`、`GET|PUT|DELETE /api/agent/runtimes/:id`
- `GET /health`（免鉴权探活）

## AgentCore 口径（诚实原则）

- `SERVER_RUNTIME=local`（默认）：进程内确定性模拟运行时，事件形状与 Python 版一致并标注 simulated；
- `SERVER_RUNTIME=agentcore`：经官方 SDK 调 `InvokeAgentRuntime`，响应流解析为 RunEvent 并落控制面库；
  未配置（缺 region/ARN）时 health 报告 `not_configured`、invoke 抛 503，不伪装可用；
- `/api/agent/*` 管理面封装控制面 SDK 的 Runtime CRUD；未配置 region 时同样 503；
- 上述 AgentCore 传输按 SDK 契约实现，**本期未做真实 AWS 联调**（无账号配置），联调在后续阶段。

审批语义与 Python 版一致：敏感步挂起 `awaiting_approval` 并补建 Approval（金额从已落库
tool_called 事件推导，不重演计划猜数）；决策走带 `status='pending'` 条件的原子 UPDATE，
重复决策 409；拒绝把 Run 收口 failed。

## 启动

```bash
npm install
cp .env.example .env   # 或直接用环境变量
npm run build && npm start     # 或 npm run dev（tsx watch）
```

环境变量见 `.env.example`：`SERVER_HOST/SERVER_PORT/SERVER_PASSWORD/SERVER_DB/
SERVER_RUNTIME/SERVER_USER_ID/AWS_REGION/AGENTCORE_RUNTIME_ARN`。
守卫：host 非回环且口令仍为默认 `demo` 时拒绝启动。

## 验证

```bash
npm run typecheck   # strict 零错误
npm test            # vitest 全过
```
