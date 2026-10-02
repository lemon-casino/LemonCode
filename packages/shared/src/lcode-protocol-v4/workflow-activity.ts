import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const workflowNodeActivitySchema = z
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
export type WorkflowNodeActivity = z.infer<typeof workflowNodeActivitySchema>;

export const workflowNodeWaitSchema = z
  .object({
    cause: z.enum(["slot", "backoff"]),
    reason: z.string().min(1).max(64).optional(),
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    since: timestamp.optional(),
    nextRetryAt: timestamp.optional(),
  })
  .strict();
export type WorkflowNodeWait = z.infer<typeof workflowNodeWaitSchema>;

export const workflowNodePhaseSchema = z.enum([
  "queued",
  "dispatched",
  "executing",
  "waiting",
  "repairing",
  "nudged",
  "paused",
  "settled",
]);

export const workflowNodeQueueSchema = z
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
export type WorkflowNodeQueue = z.infer<typeof workflowNodeQueueSchema>;
