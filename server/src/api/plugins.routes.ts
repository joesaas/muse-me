import type { FastifyInstance } from "fastify";
import type { PluginService } from "../application/plugin.service.js";
import { bodyOf } from "./auth.routes.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 插件薄控制器：目录列表 / 按模板安装（返回脚本 JSON，同脚本口径）。 */
export function registerPluginRoutes(app: FastifyInstance, plugins: PluginService): void {
  app.get("/api/plugins", async () => plugins.list());

  app.post("/api/plugins/:id/install", async (request) => {
    const { id } = request.params as { id: string };
    const body = bodyOf(request);
    const params = isPlainObject(body.params) ? body.params : {};
    const script = plugins.install(id, params);
    const docParams = Array.isArray(script.doc?.params) ? script.doc.params : [];
    return {
      id: script.id,
      name: script.name,
      description: script.description,
      version: script.currentVersion,
      params: docParams,
    };
  });
}
