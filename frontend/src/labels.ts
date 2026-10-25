// 枚举 → 人话映射集中表：所有视图只经这里渲染英文枚举，
// 未知值一律回退为中性中文，绝不把后端英文原值直出到界面。
// （四维评审 FE-6；ScriptsView 原 TOOL_LABELS 亦收归此处。）

export function riskLabel(v: string | undefined | null): string {
  switch (v) {
    case "read":
      return "只读";
    case "write":
      return "写入";
    case "irreversible":
      return "不可撤销";
    case "low":
      return "低风险";
    case "medium":
      return "中风险";
    case "high":
      return "高风险";
    case undefined:
    case null:
    case "":
      return "未知风险";
    default:
      return "未知风险";
  }
}

export function runStatusLabel(v: string | undefined | null): string {
  switch (v) {
    case "running":
      return "进行中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "awaiting_approval":
      return "等你确认";
    case "pending":
      return "等待中";
    case undefined:
    case null:
    case "":
      return "未知状态";
    default:
      return "未知状态";
  }
}

export function scriptRunStatusLabel(v: string | undefined | null): string {
  switch (v) {
    case "done":
      return "试运行完成";
    case "awaiting_approval":
      return "停在待确认";
    case "failed":
      return "试运行失败";
    default:
      return runStatusLabel(v);
  }
}

export function approvalStatusLabel(v: string | undefined | null): string {
  switch (v) {
    case "pending":
      return "等你拍板";
    case "approved":
      return "已批准";
    case "denied":
      return "已拒绝";
    default:
      return runStatusLabel(v);
  }
}

export function memoryLevelLabel(v: string | undefined | null): string {
  switch (v) {
    case "fact":
      return "事实";
    case "inference":
      return "推测";
    case "never":
      return "永不记录";
    default:
      return "未知类别";
  }
}

export function memoryStatusLabel(v: string | undefined | null): string {
  switch (v) {
    case "active":
      return "已生效";
    case "pending":
      return "等你批准";
    case "rejected":
      return "已拒绝";
    default:
      return runStatusLabel(v);
  }
}

export function jobLastStatusLabel(v: string | undefined | null): string {
  switch (v) {
    case undefined:
    case null:
    case "":
      return "还没跑过";
    default:
      return runStatusLabel(v);
  }
}

export function eventTypeLabel(v: string | undefined | null): string {
  switch (v) {
    case "plan_created":
      return "已制定计划";
    case "step_started":
      return "开始执行步骤";
    case "tool_called":
      return "调用工具";
    case "step_done":
      return "步骤完成";
    case "approval_required":
      return "需要你确认";
    case "assistant_delta":
      return "助手回复中";
    case "run_done":
      return "运行完成";
    case "run_failed":
      return "运行失败";
    case "run_cancelled":
      return "运行已取消";
    case undefined:
    case null:
    case "":
      return "动态更新";
    default:
      return "动态更新";
  }
}

export function fileKindLabel(v: string | undefined | null): string {
  switch (v) {
    case "script_export":
      return "脚本导出";
    case "evaluation_report":
      return "评估报告";
    case "document":
      return "文档";
    default:
      return "文件";
  }
}

export function connectionStatusLabel(v: string | undefined | null): string {
  switch (v) {
    case "ok":
      return "正常";
    case "connected":
      return "已连接";
    case "not_configured":
      return "未配置";
    case "error":
    case "failed":
      return "异常";
    default:
      return "未知状态";
  }
}

export function runKindLabel(v: string | undefined | null): string {
  switch (v) {
    case "chat":
      return "聊天";
    case "script":
      return "脚本";
    case "job":
      return "定时任务";
    default:
      return "运行";
  }
}

export function triggerOpLabel(op: string | undefined | null): string {
  switch (op) {
    case ">":
      return "高于";
    case "<":
      return "低于";
    case ">=":
      return "不低于";
    case "<=":
      return "不高于";
    case "==":
    case "=":
      return "等于";
    default:
      return "达到";
  }
}

export const TOOL_LABELS: Record<string, string> = {
  "meme.scan": "查流动性与风险",
  "market.quote": "询价",
  "dex.quote": "询价",
  "dex.sim_swap": "模拟买入",
  "aave.rates": "查 Aave 利率",
  "aave.sim_supply": "模拟存入 Aave",
  "news.search": "搜新闻",
  "web.fetch": "抓取网页",
  "notify.send": "发通知",
};

export function toolLabel(v: string | undefined | null): string {
  if (!v) return "工具";
  return TOOL_LABELS[v] ?? "工具";
}

// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；无时间回落「时间未知」，
// 解析失败回落原文（与旧版 FeedView 本地实现同一口径，现收进映射表供右栏复用）。
export function relativeTimeLabel(iso: string | undefined | null): string {
  if (!iso) return "时间未知";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return iso;
}
