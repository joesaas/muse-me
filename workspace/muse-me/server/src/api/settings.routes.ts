import type { FastifyInstance } from "fastify";
import type { SettingsService } from "../application/settings.service.js";

/** 设置薄控制器：账号与连接只读清单（只报状态与引用名，不回显密钥）。 */
export function registerSettingsRoutes(
  app: FastifyInstance,
  settings: SettingsService,
): void {
  app.get("/api/settings/connections", async () => settings.connections());
}
