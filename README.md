# muse-me

类 Muse 的个人 Agent Demo：只有 Web 端，但从设计到实现按完整产品做——
产品功能（聊天/今日精选/我的脚本/定时任务/待我确认）、一套可替换的 Agent
运行时、一套完整 Harness 工程（执行层/驾驭层/评估层）三部分齐全。

> **定版决定（2026-10-24）**：Python API / 服务 / 调度层冻结产品演进（只修安全问题与回归，不再加功能）；后续演进面为 `server/` 控制面 + Python 的 `execution` / `harness` / `tools` / `agentcore_app`；Python 全栈保留作 legacy 回退入口。形态 A / B 数据不连续：两边各用各的 SQLite 库，切换形态不迁移历史数据（聊天、脚本、审批、任务、轨迹都不连续）；「回退」指代码入口回退、不是数据回退。部署口径见 `DEPLOYMENT.md`（Step 2：server 用自己的库 `server/data/server.db`，与 Python 的库互不干扰）。

## 架构（文字版）

```
Web 前端（Vue 3 + TypeScript SPA，六个小白菜单） ── REST + SSE ──┐
API 层（http.server：路由 / 口令登录 / SSE 事件流 / 静态文件）
应用服务层（services.py）
  ChatService / ScriptService / JobService / FeedService
  ApprovalService / MemoryService / SettingsService
领域层（domain.py：纯数据与状态机，无 I/O）
Harness 层
  执行层：五原语（串行/路由/并行/反思/委派）+ Planner + Orchestrator
  驾驭层：harness/ 目录文件为正本（原则/手册/护栏/场景/工具目录）
  评估层：evaluation/cases 回归集 + runner + 迭代门 gate()
端口 Ports（ports.py 的 Protocol）
适配器：LocalRuntime / AgentCoreRuntime(桩) · MockModel / OpenRouterModel
        SqliteStore · SeedNews · SchedulerDaemon（独立线程）
```

设计原则见 `docs/architecture.md`（定版），细节见 `docs/detailed-design.md`，
任务拆分见 `docs/task-breakdown.md`，部署见根目录 `DEPLOYMENT.md`。

## 启动

后端（Python 3.11+，标准库零依赖；仓库根目录执行）：

```bash
PYTHONPATH=src python3 -m muse_me
# 默认 http://127.0.0.1:8765/ ，登录口令 demo
# 可改环境变量：MUSE_ME_PORT / MUSE_ME_PASSWORD / MUSE_ME_DB
# 真实模型：MUSE_ME_MODEL=openrouter 且设置 OPENROUTER_API_KEY（默认 Mock 离线模型）
```

前端（Vue 3 + Vite + TypeScript，改 `frontend/src/` 后需重新构建，产物输出到 `web/`）：

```bash
cd frontend && npm install && npm run build
```

## 测试

```bash
python3 -m unittest discover -s tests        # 核心层 + 服务层/API 冒烟
python3 -m muse_me.evaluation              # 评估层回归集（PYTHONPATH=src）
```

## 演示动线（五步）

1. **今日精选**：看一条 meme 新闻，点「基于此构建脚本」，新闻与实体自动带入新话题。
2. **聊天共创**：说「买这个 meme，100 美元，先查流动性」，助手查风险、报价、
   模拟成交，并把做法存成脚本《新闻驱动 meme 买入》。
3. **待我确认**：模拟成交前的敏感步停在审批队列，批准后才继续，拒绝即停止并留痕。
4. **我的脚本**：试运行（沙箱，不建审批）、改参数重跑，或把脚本「设为定时任务」。
5. **定时任务 + 执行记录**：到点自动执行（敏感步仍转审批）；每次运行的轨迹在
   「执行记录」里可回放；推断类记忆在「它记得的事」里等你批准才生效。

## AgentCore 对比说明（未实测标注）

运行时经 `RuntimePort` 五法抽象：第一实现 `LocalRuntime`（进程内、已实测）；
`AgentCoreRuntime` 为同接口桩——未配置时 `health()` 返回 `not_configured`，
`invoke` 抛 `RuntimeNotConfigured` 并附配置指引（需 `AWS_REGION` 与
`AGENTCORE_RUNTIME_ARN`）。**AgentCore 真实传输尚未联调，本文不宣称已实测**；
定版口径是自托管先行、适配层留接口，阶段 5 完成真实传输后再补同题对比
（冷启动/单轮成本/运维工时）。已知约束：托管运行时按会话计费、单会话时长
有限，全天候调度（Bot 与 Feed 生成）无论如何都独立于会话存活——本项目的
SchedulerDaemon 即按此设计，与运行时解耦。
