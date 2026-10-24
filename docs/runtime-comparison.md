# 运行时对比：LocalRuntime（自托管） vs AWS Bedrock AgentCore

> 口径：本地侧为 2026-10-24 本机实测；AgentCore 侧为公开价目与官方口径，**未实测**（桩实现，未接 AWS 账号），凡未实测处明确标注。

## 同题任务

在聊天里构建并运行《新闻驱动 meme 买入》脚本（scan → quote → 审批 → sim_swap）。

| 维度 | LocalRuntime（实测） | AgentCore（未实测，公开资料） |
|---|---|---|
| 部署形态 | 本机/EC2 单进程 Python 服务 | 托管 microVM 会话，容器打包部署 |
| 冷启动 | 进程常驻，无会话冷启动；单轮 Run 为毫秒级（Mock 模型） | 官方称 V2 快照恢复 P75 约 1.9–2.0 秒（厂商自报，未复测） |
| 运行时计费 | 固定机时成本，增量近零 | $0.0895 / vCPU·小时 + $0.00945 / GB·小时（V1 价目，2026-10 查 AWS 官方价目页）；等待 I/O 不计 CPU |
| 会话上限 | 无（自托管） | 单会话最长约 8 小时；定时任务仍需独立调度器（与本项目架构一致：SchedulerDaemon 独立常驻） |
| 模型 | Mock 默认 / OpenRouter 可选，不绑厂商 | 经 Bedrock 调用各厂商模型，token 另计 |
| 运维工时 | 低：一条命令起服务 | 高：IAM、容器打包、Gateway 配置（经验估计，未实测） |
| 可观测 | 本地 Run/RunEvent 全量落 SQLite | CloudWatch 计费另计 |

## 结论

Demo 阶段自托管是正确选择：成本近零、迭代最快、调度不受会话上限约束。AgentCore 的价值在规模化与企业治理（IAM/VPC/审计），不在 Demo 阶段。`AgentCoreRuntime` 已按同一 `RuntimePort` 五法接口留好实现位（未配置时 health 返回 `not_configured` 并给出配置指引），待有 AWS 账号后补真实传输层，再按本表同题复测更新「未实测」项。
