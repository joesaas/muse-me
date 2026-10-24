import { describe, expect, it } from "vitest";
import { assertSafeToStart, loadConfig, makeConfig } from "../src/config.js";

describe("config 解析与校验", () => {
  it("默认值：local 运行时、回环地址、demo 口令", () => {
    const cfg = loadConfig({});
    expect(cfg.runtimeMode).toBe("local");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.password).toBe("demo");
    expect(cfg.agentcore.region).toBe("");
  });

  it("非法 SERVER_RUNTIME 直接抛错，不静默降级", () => {
    expect(() => loadConfig({ SERVER_RUNTIME: "nest" })).toThrow(/SERVER_RUNTIME 非法/);
  });

  it("非法 SERVER_PORT 直接抛错", () => {
    expect(() => loadConfig({ SERVER_PORT: "abc" })).toThrow(/SERVER_PORT 非法/);
    expect(() => loadConfig({ SERVER_PORT: "70000" })).toThrow(/SERVER_PORT 非法/);
  });

  it("AWS_REGION 回退口径：AGENTCORE_REGION 优先", () => {
    const cfg = loadConfig({ AWS_REGION: "us-east-1", AGENTCORE_REGION: "eu-west-1" });
    expect(cfg.agentcore.region).toBe("eu-west-1");
  });
});

describe("启动守卫（非回环 + 默认口令拒绝启动）", () => {
  it("回环 + 默认口令：放行", () => {
    expect(() =>
      assertSafeToStart(makeConfig({ host: "127.0.0.1", password: "demo" })),
    ).not.toThrow();
  });

  it("非回环 + 默认口令：拒绝", () => {
    expect(() =>
      assertSafeToStart(makeConfig({ host: "0.0.0.0", password: "demo" })),
    ).toThrow(/拒绝启动/);
  });

  it("非回环 + 自定义口令：放行", () => {
    expect(() =>
      assertSafeToStart(makeConfig({ host: "0.0.0.0", password: "s3cret" })),
    ).not.toThrow();
  });
});
