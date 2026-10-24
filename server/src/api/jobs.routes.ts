import type { FastifyInstance } from "fastify";
import type { JobService } from "../application/job.service.js";
import { bodyOf } from "./auth.routes.js";
import { jobJson } from "./serializers.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 定时任务薄控制器（同 Python api.py 的 jobs 路由）。 */
export function registerJobRoutes(app: FastifyInstance, jobs: JobService): void {
  app.get("/api/jobs", async () =>
    jobs.list().map((job) => jobJson(job, jobs.lastStatus(job.id))),
  );

  app.post("/api/jobs", async (request) => {
    const body = bodyOf(request);
    const trigger = isPlainObject(body.trigger)
      ? body.trigger
      : { type: "time", every_minutes: 60 };
    const job = jobs.create({
      name: typeof body.name === "string" && body.name ? body.name : "定时任务",
      scriptId: String(body.script_id ?? ""),
      trigger,
      params: isPlainObject(body.params) ? body.params : {},
    });
    return jobJson(job, jobs.lastStatus(job.id));
  });

  app.post("/api/jobs/:id/toggle", async (request) => {
    const { id } = request.params as { id: string };
    const job = jobs.toggle(id);
    return jobJson(job, jobs.lastStatus(job.id));
  });
}
