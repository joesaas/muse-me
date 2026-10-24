# MuseMe 部署手册

> 三个组件：前端 `frontend/`（Vue 3，构建产物 `web/`）、Agent 本体 `src/muse_me`（Python，零依赖）、控制面 `server/`（Fastify + TS）。按 Step 顺序操作即可。

## 部署形态总览

| 形态 | 说明 | 状态 |
|---|---|---|
| A 单机全栈 | Python 一进程跑全部：API + 前端静态页 + 调度。最简单 | ✅ 现行默认 |
| B 控制面分离 | `server/` 独立进程提供全部 API 并管理 AgentCore；Python 做 Agent 本体 | ✅ server 第二期已迁完全部路由并同源托管前端，前端默认指向 server（Python 侧同名 API 保留作回退） |
| C AgentCore 托管 | Agent 本体部署进 AWS Bedrock AgentCore，server 经 ARN 调用 | 🔧 控制面客户端已实现；Agent 侧入口待补（见 Step 5） |

## Step 0 前置要求

- Python ≥ 3.11、Node ≥ 22、npm；磁盘预留 500 MB（含 node_modules）。
- 端口：Python `8765`、server `8787`（均可改，见环境变量表）。
- 形态 C 另需：AWS 账号、Bedrock 模型访问权限、一个 AgentCore 执行角色（IAM）。

## Step 1 形态 A：单机全栈部署

```bash
git clone https://github.com/joesaas/muse-me && cd muse-me
cd frontend && npm install && npm run build && cd ..   # 产物输出到 web/
PYTHONPATH=src python3 -m muse_me                      # 起服务
```

- 打开 http://127.0.0.1:8765 ，口令 `demo` 登录。
- 数据落在 SQLite 文件（默认仓库根 `data/` 下，可用 `MUSE_ME_DB` 指定）；备份就是拷这个文件。
- 改了 `frontend/src/` 必须重跑 `npm run build`，否则页面是旧版。

常用环境变量：

```bash
MUSE_ME_HOST=127.0.0.1 MUSE_ME_PORT=8765 \
MUSE_ME_PASSWORD=<自定义口令> \
MUSE_ME_MODEL=openrouter OPENROUTER_API_KEY=<key> \   # 不设则用离线 Mock 模型
PYTHONPATH=src python3 -m muse_me
```

## Step 2 形态 B：启动控制面 server/

```bash
cd server && npm install && npm run build
SERVER_PASSWORD=<自定义口令> npm start                 # 默认 127.0.0.1:8787
```

- 配置见 `server/.env.example`（可复制为 `.env` 或直接传环境变量）。
- 验证：`curl http://127.0.0.1:8787/api/agent/health` —— 未配 AWS 时应返回 `runtimeMode: "local"` 且 `agentcore.status: "not_configured"`，这是正常口径，不是报错。
- server 用自己的库 `server/data/server.db`（`SERVER_DB` 可改），与 Python 的库互不干扰。
- 前端由 server 同源托管（`web/`）并调用 server 的 API，已完成切换；Python 进程的同名 API 与静态托管保留，可作回退。

## Step 3 对外提供服务（绑非本机地址时必读）

两层都有同一条硬守卫，绕不过去，也不要绕：

- 监听地址非回环（`0.0.0.0` 等）且口令仍为默认 `demo` → **拒绝启动**。必须先设自定义口令（Python 用 `MUSE_ME_PASSWORD`，server 用 `SERVER_PASSWORD`）。
- 公网场景再加一层：用 nginx/Caddy 反向代理终结 HTTPS，只把代理端口暴露出去，应用端口只监听回环。

常驻运行（任选其一，示例为 systemd 用户服务）：

```bash
systemctl --user edit --force --full museme.service   # ExecStart 填 Step 1 的启动命令（绝对路径）
systemctl --user enable --now museme
journalctl --user -u museme -f                        # 看日志
```

## Step 4 更新与回滚

更新：

```bash
cp <MUSE_ME_DB 路径> backup-$(date +%F).db             # 先备份数据
git pull
cd frontend && npm run build && cd ..                  # 前端有改动时
cd server && npm run build && cd ..                    # 控制面有改动时
# 重启进程后走 Step 6 验证清单
```

回滚：`git checkout <上一个正常 commit>` → 重建前端/server → 如数据异常，停服后用备份覆盖 DB 再启动。

## Step 5 形态 C：把 Agent 部署进 AgentCore（目标形态）

现状如实：server 侧的调用与管理客户端是真实现、已本地验证协议形状；**Agent 侧的 AgentCore 入口模块尚未补**，以下为补齐后执行的标准流程。

1. **准备 AWS**：开通 Bedrock 与 AgentCore，建执行角色（权限：调用 Bedrock 模型 + 写 CloudWatch 日志），记下区域（如 `us-east-1`）。
2. **补 Agent 入口**：在 Python 包加 `agentcore_app.py`——用官方 SDK `bedrock-agentcore` 的 `BedrockAgentCoreApp` 暴露入口，内部驱动现有 Orchestrator；本地起服后自测契约：`GET :8080/ping` 返回健康、`POST :8080/invocations` 能跑完一次运行并流式返回事件。
3. **部署**：直接代码部署（迭代最快）：入口文件 + 依赖打包为 zip，运行时选 `PYTHON_3_12`、架构 `linux/arm64`；或用 AgentCore CLI `agentcore deploy`。部署成功后记下 **Runtime ARN**。
4. **接控制面**：

```bash
cd server
SERVER_RUNTIME=agentcore AWS_REGION=us-east-1 \
AGENTCORE_RUNTIME_ARN=<上一步的 ARN> \
SERVER_PASSWORD=<自定义口令> npm start
```

5. **验证**：`/api/agent/health` 应显示 `agentcore.status` 已配置；从页面发一条消息，事件流应来自云端运行（执行记录里可核对）。这一步即验收清单第 10 条「AgentCore 同题跑通」，未完成前不要宣称已上云。

## Step 6 上线验证清单

| # | 检查 | 期望 |
|---|---|---|
| 1 | 打开首页登录 | 口令可登录，无报错 |
| 2 | 今日精选 | 有条目；改「我想看什么」保存后内容随变 |
| 3 | 精选点「基于此构建脚本」→ 发「买这个 meme，100 美元」 | 依次出现查风险、报价，最后停在待审批 |
| 4 | 待我确认 → 批准 | 运行完成，执行记录状态 done |
| 5 | 我的脚本 → 试运行 | 步骤清单完整，不建审批 |
| 6 | 定时任务 | 到点执行；敏感步仍转审批 |
| 7 | （形态 B/C）`/api/agent/health` | 口径与所配形态一致 |

任一项不过，先查 Step 7，不要改代码。

## Step 7 故障排查

| 症状 | 先查什么 |
|---|---|
| 启动即退出、提示拒绝启动 | 绑了非回环地址但口令是默认 `demo`——设自定义口令（Step 3） |
| 端口占用、连上的是旧页面/旧数据 | 有旧进程没停：查端口占用，停掉后重启；这曾真实发生过 |
| 页面功能旧、改动不生效 | 前端没重构建（Step 1 注记）或浏览器缓存，强刷一次 |
| 启动报工具目录不一致 | harness/tools/catalog.md 与工具注册表漂移——这是有意的启动校验，修目录或注册表使之一致，不要关校验 |
| health 显示 not_configured | 没配 `AGENTCORE_RUNTIME_ARN`/`AWS_REGION`，或 server 仍是 local 模式 |
| 发消息无事件流 | 看执行记录里该 run 的状态与事件；服务日志查 `[api] internal error` |
| 审批批准后没续跑 | server 形态下计划在进程内存中：控制面重启会丢 awaiting 中的运行，重新发起即可（已知限制，见 server README） |

## 环境变量总表

| 变量 | 组件 | 默认 | 说明 |
|---|---|---|---|
| `MUSE_ME_HOST` / `MUSE_ME_PORT` | Python | `127.0.0.1` / `8765` | 监听地址/端口 |
| `MUSE_ME_PASSWORD` | Python | `demo` | 登录口令，非回环时必须改 |
| `MUSE_ME_DB` | Python | `data/` 下 | SQLite 路径 |
| `MUSE_ME_MODEL` | Python | `mock` | `openrouter` 时需 `OPENROUTER_API_KEY` |
| `SERVER_HOST` / `SERVER_PORT` | server | `127.0.0.1` / `8787` | 监听地址/端口 |
| `SERVER_PASSWORD` | server | `demo` | 登录口令，非回环时必须改 |
| `SERVER_DB` | server | `data/server.db` | SQLite 路径（相对启动 cwd） |
| `SERVER_RUNTIME` | server | `local` | `local` 或 `agentcore` |
| `AWS_REGION` / `AGENTCORE_RUNTIME_ARN` | server | 空 | 形态 C 必填 |
