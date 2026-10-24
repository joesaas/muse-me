import type { FastifyInstance } from "fastify";
import type { ApprovalService } from "../application/approval.service.js";
import { ValidationFailed } from "../domain/errors.js";
import { bodyOf } from "./auth.routes.js";
import { approvalJson } from "./serializers.js";

/**
 * decide 的 approved 必须为 JSON 布尔：字符串 "false" 经真值判断会变批准，
 * 语义反转代价最高，必须严校验（评审定版口径，与 Python _approved_flag 一致）。
 */
export function parseApprovedFlag(body: Record<string, unknown>): boolean {
  const value = body.approved;
  if (typeof value !== "boolean") {
    throw new ValidationFailed("approved 必须是布尔值 true 或 false");
  }
  return value;
}

export function registerApprovalRoutes(
  app: FastifyInstance,
  approvals: ApprovalService,
): void {
  app.get("/api/approvals", async (request) => {
    const query = request.query as { status?: string };
    return approvals.list(query.status).map(approvalJson);
  });

  app.post("/api/approvals/:id/decide", async (request) => {
    const { id } = request.params as { id: string };
    const body = bodyOf(request);
    const approved = parseApprovedFlag(body);
    const decided = await approvals.decide(id, approved, String(body.reason ?? ""));
    return approvalJson(decided);
  });
}
