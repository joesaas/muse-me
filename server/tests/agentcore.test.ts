import { describe, expect, it } from "vitest";
import { RuntimeNotConfigured } from "../src/domain/errors.js";
import { AgentCoreAdmin } from "../src/infrastructure/agentcore/agentcore-admin.js";
import { AgentCoreRuntime } from "../src/infrastructure/runtime/agentcore-runtime.js";

const UNCONFIGURED = { region: "", runtimeArn: "" };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("AgentCoreRuntime 未配置口径", () => {
  it("health 报告 not_configured 并附配置指引", async () => {
    const runtime = new AgentCoreRuntime(UNCONFIGURED);
    const health = await runtime.health();
    expect(health.status).toBe("not_configured");
    expect(health.runtime).toBe("agentcore");
    expect(String(health.hint)).toContain("AGENTCORE_RUNTIME_ARN");
  });

  it("createSession 抛 RuntimeNotConfigured（503 口径）", () => {
    const runtime = new AgentCoreRuntime(UNCONFIGURED);
    expect(() => runtime.createSession("demo-user", "chat")).toThrow(RuntimeNotConfigured);
  });

  it("invoke 抛 RuntimeNotConfigured，不产出伪造事件", async () => {
    const runtime = new AgentCoreRuntime(UNCONFIGURED);
    await expect(
      collect(runtime.invoke("s".repeat(40), "买这个 meme，100 美元")),
    ).rejects.toThrow(RuntimeNotConfigured);
  });

  it("cancel 返回 false、getTrace 返回空（与 Python 桩同口径）", async () => {
    const runtime = new AgentCoreRuntime(UNCONFIGURED);
    await expect(runtime.cancel("run-1")).resolves.toBe(false);
    await expect(runtime.getTrace("run-1")).resolves.toEqual([]);
  });

  it("只配 region 没配 ARN 仍是未配置", async () => {
    const runtime = new AgentCoreRuntime({ region: "us-east-1", runtimeArn: "" });
    expect((await runtime.health()).status).toBe("not_configured");
  });
});

describe("AgentCoreAdmin 未配置口径", () => {
  it("health 报告 not_configured", async () => {
    const admin = new AgentCoreAdmin(UNCONFIGURED);
    const health = await admin.health();
    expect(health.status).toBe("not_configured");
    expect(health.plane).toBe("agentcore-control");
  });

  it("资源管理方法未配置时全部抛 RuntimeNotConfigured", async () => {
    const admin = new AgentCoreAdmin(UNCONFIGURED);
    await expect(admin.listRuntimes()).rejects.toThrow(RuntimeNotConfigured);
    await expect(admin.getRuntime("x")).rejects.toThrow(RuntimeNotConfigured);
    await expect(
      admin.createRuntime({ name: "a", containerUri: "u", roleArn: "r" }),
    ).rejects.toThrow(RuntimeNotConfigured);
    await expect(admin.updateRuntime("x", {})).rejects.toThrow(RuntimeNotConfigured);
    await expect(admin.deleteRuntime("x")).rejects.toThrow(RuntimeNotConfigured);
  });
});
