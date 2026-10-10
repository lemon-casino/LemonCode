import { z } from "zod";
import { goalAcceptanceSchema } from "../goal-evidence.js";
import { modelSelectionSchema } from "../model-selection.js";
import { submissionModeSchema } from "./submission.js";

export const goalCommandPayloadSchema = z.object({
  text: z.string(),
  displayText: z.string().optional(),
  modelSelection: modelSelectionSchema.optional(),
  mode: submissionModeSchema.optional(),
  planEnabled: z.boolean().optional(),
  heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
  expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
});
// 新命令身份让旧执行端明确拒绝，不能丢弃 acceptance 后接纳成 legacy。
export const strictGoalCommandPayloadSchema = goalCommandPayloadSchema
  .extend({ acceptance: goalAcceptanceSchema })
  .strict();
