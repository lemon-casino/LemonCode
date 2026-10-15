import { z } from "zod";

/** Resume 的业务拒绝词表；工具、ACK 与 UI 共用，不接受客户端自行增加恢复权限。 */
export const workflowRunResumeRejectionReasonSchema = z.enum([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
  "owner_unavailable",
]);
export type WorkflowRunResumeRejectionReason = z.infer<
  typeof workflowRunResumeRejectionReasonSchema
>;
