import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// CLI 工具使用 Zod 3，shared V4 使用 Zod 4；两种 schema 不能嵌套，跨边界用例验证逐字段一致。
export const WorkflowNodeActivitySchema = z
  .object({
    kind: z.enum(["model", "text", "reasoning", "tool", "unknown"]),
    observedAt: timestamp,
    since: timestamp,
    requestsCompleted: count,
    toolCalls: count,
    requestId: z.string().min(1).max(256).optional(),
    toolName: z.string().min(1).max(64).optional(),
    lastRequestCompletedAt: timestamp.optional(),
  })
  .strict();

export const WorkflowNodePhaseSchema = z.enum([
  "queued",
  "dispatched",
  "executing",
  "waiting",
  "repairing",
  "nudged",
  "paused",
  "settled",
]);

export const WorkflowNodeQueueSchema = z
  .object({
    cause: z.enum(["actor-fifo", "run-capacity"]),
    since: timestamp.optional(),
    blockedBy: z
      .object({
        siteId: z.string().min(1).max(64),
        ordinal: count,
        attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
