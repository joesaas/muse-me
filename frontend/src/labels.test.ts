// 人话映射表测试（四维评审 FE-6）：已知值映射正确，
// 未知值回退中性中文，绝不原样返回英文枚举。
import { describe, expect, it } from "vitest";
import {
  approvalStatusLabel,
  connectionStatusLabel,
  eventTypeLabel,
  fileKindLabel,
  jobLastStatusLabel,
  memoryLevelLabel,
  memoryStatusLabel,
  riskLabel,
  runStatusLabel,
  toolLabel,
} from "./labels";

describe("labels", () => {
  it("风险与状态映射", () => {
    expect(riskLabel("read")).toBe("只读");
    expect(riskLabel("write")).toBe("写入");
    expect(riskLabel("irreversible")).toBe("不可撤销");
    expect(riskLabel("high")).toBe("高风险");
    expect(runStatusLabel("awaiting_approval")).toBe("等你确认");
    expect(runStatusLabel("running")).toBe("进行中");
    expect(approvalStatusLabel("pending")).toBe("等你拍板");
    expect(approvalStatusLabel("denied")).toBe("已拒绝");
    expect(jobLastStatusLabel(undefined)).toBe("还没跑过");
    expect(jobLastStatusLabel("failed")).toBe("失败");
  });

  it("记忆三值映射：never 不再标成推测", () => {
    expect(memoryLevelLabel("fact")).toBe("事实");
    expect(memoryLevelLabel("inference")).toBe("推测");
    expect(memoryLevelLabel("never")).toBe("永不记录");
    expect(memoryStatusLabel("rejected")).toBe("已拒绝");
  });

  it("事件类型、文件类别、连接状态映射", () => {
    expect(eventTypeLabel("plan_created")).toBe("已制定计划");
    expect(eventTypeLabel("tool_called")).toBe("调用工具");
    expect(eventTypeLabel("approval_required")).toBe("需要你确认");
    expect(fileKindLabel("script_export")).toBe("脚本导出");
    expect(connectionStatusLabel("not_configured")).toBe("未配置");
  });

  it("未知值回退中性中文，不直出英文原值", () => {
    for (const [fn, v] of [
      [riskLabel, "bogus"],
      [runStatusLabel, "bogus"],
      [eventTypeLabel, "bogus_event"],
      [fileKindLabel, "bogus_kind"],
      [connectionStatusLabel, "bogus"],
      [toolLabel, "dex.unknown"],
    ] as const) {
      const out = fn(v);
      expect(out).not.toBe(v);
      expect(out).not.toMatch(/[a-z_]{4,}/);
    }
    expect(toolLabel("dex.sim_swap")).toBe("模拟买入");
    expect(toolLabel("")).toBe("工具");
  });
});
