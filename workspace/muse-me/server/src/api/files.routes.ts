import type { FastifyInstance } from "fastify";
import type { FileService } from "../application/file.service.js";
import { fileJson } from "./serializers.js";

/** 文件薄控制器：列表与下载（下载头与 Python _send_text 同口径）。 */
export function registerFileRoutes(app: FastifyInstance, files: FileService): void {
  app.get("/api/files", async () => files.list().map(fileJson));

  app.get("/api/files/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const download = files.download(id);
    return reply
      .header("Content-Type", "application/json")
      .header(
        "Content-Disposition",
        `attachment; filename="export.json"; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
      )
      .send(download.content);
  });
}
