import { z } from "zod";
import {
  WORKFLOW_ORCHESTRATION_ADVICE_CODES,
  WORKFLOW_ORCHESTRATION_ADVICE_LIMITS,
} from "@lcode/shared/lcode-protocol-v4";

// CLI 用 Zod3 生成工具 JSON schema，shared 用 Zod4；这里只镜像边界，常量与消费者仍共享。
const locationSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  })
  .strict();
const locationsSchema = z
  .array(locationSchema)
  .min(1)
  .max(WORKFLOW_ORCHESTRATION_ADVICE_LIMITS.maxLocations);

export const WorkflowOrchestrationAdviceSchema = locationSchema
  .extend({
    code: z.enum(WORKFLOW_ORCHESTRATION_ADVICE_CODES),
    waitingOn: locationsSchema,
    delayed: locationsSchema,
    message: z.string().min(1).max(WORKFLOW_ORCHESTRATION_ADVICE_LIMITS.maxMessageChars),
  })
  .strict();

export const WorkflowOrchestrationAdviceListSchema = z
  .array(WorkflowOrchestrationAdviceSchema)
  .min(1)
  .max(WORKFLOW_ORCHESTRATION_ADVICE_LIMITS.maxItems);
export const WorkflowOrchestrationAdviceBundleSchema = z
  .object({
    scriptHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
    items: WorkflowOrchestrationAdviceListSchema,
  })
  .strict();
