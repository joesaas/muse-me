import { buildApp } from "./app.js";
import { assertSafeToStart, loadConfig, DEFAULT_PASSWORD } from "./config.js";

/**
 * 入口：只负责读配置 -> 安全守卫 -> buildApp -> listen。
 * 守卫口径对齐 Python __main__：非回环绑定 + 默认口令 -> 拒绝启动；
 * 启动日志永不打印口令明文。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  assertSafeToStart(config);
  const { app } = buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  console.log(`MuseMe server（控制面）已启动：http://${config.host}:${config.port}`);
  console.log(`运行时模式：${config.runtimeMode}`);
  if (config.password === DEFAULT_PASSWORD) {
    console.log(
      "当前为默认口令 demo（仅限本地回环），正式使用请设置 SERVER_PASSWORD。",
    );
  } else {
    console.log("登录口令已设置（不显示）。");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
