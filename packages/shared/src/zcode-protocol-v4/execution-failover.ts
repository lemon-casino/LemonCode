import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { timestampSchema } from "./core.js";

export const MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS = 64;
/** One foreground target plus every background target admitted by a command. */
export const MAX_EXECUTION_FAILOVER_TARGETS = MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS + 1;

export const executionFailoverEligibleBackgroundWorkIdsSchema = z
  .array(z.string().trim().min(1))
  .max(MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eligible background work ids must be unique",
      });
    }
  });
export type ExecutionFailoverEligibleBackgroundWorkIds = z.infer<
  typeof executionFailoverEligibleBackgroundWorkIdsSchema
>;

export const executionFailoverObservedTargetsSchema = z
  .object({
    foregroundExecutionId: z.string().trim().min(1).optional(),
    backgroundWorkIds: z
      .array(z.string().trim().min(1))
      .max(MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS),
  })
  .strict()
  .superRefine((targets, context) => {
    if (!targets.foregroundExecutionId && targets.backgroundWorkIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one observed execution target is required",
      });
    }
    if (new Set(targets.backgroundWorkIds).size !== targets.backgroundWorkIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["backgroundWorkIds"],
        message: "background work ids must be unique",
      });
    }
  });
export type ExecutionFailoverObservedTargets = z.infer<
  typeof executionFailoverObservedTargetsSchema
>;

export const setExecutionFailoverTargetPayloadSchema = z
  .object({
    modelSelection: modelSelectionSchema,
    observedTargets: executionFailoverObservedTargetsSchema,
  })
  .strict();
export type SetExecutionFailoverTargetPayload = z.infer<
  typeof setExecutionFailoverTargetPayloadSchema
>;

export const executionFailoverReasonCodeSchema = z.enum([
  "userRequested",
  "network.transport_unavailable",
  "provider.service_unavailable",
  "provider.rate_limited",
  "provider.authentication_failed",
  "provider.stream_unrecoverable",
  "provider.context_capacity",
]);
export type ExecutionFailoverReasonCode = z.infer<typeof executionFailoverReasonCodeSchema>;

export const executionFailoverChangeCauseSchema = z.enum([
  "userRequested",
  "eligibleFailure",
  "safeBoundaryActivated",
  "targetBlocked",
  "targetsCompleted",
  "eligibleTargetsChanged",
]);
export type ExecutionFailoverChangeCause = z.infer<typeof executionFailoverChangeCauseSchema>;

export const executionFailoverTransitionSchema = z
  .object({
    targetKind: z.enum(["foregroundExecution", "backgroundWork"]),
    targetId: z.string().trim().min(1),
    from: modelSelectionSchema,
    to: modelSelectionSchema,
    reasonCode: executionFailoverReasonCodeSchema,
    attempt: z.number().int().positive(),
    at: timestampSchema,
  })
  .strict();
export type ExecutionFailoverTransition = z.infer<typeof executionFailoverTransitionSchema>;

export const executionFailoverTargetStateSchema = z
  .object({
    kind: z.enum(["foregroundExecution", "backgroundWork"]),
    id: z.string().trim().min(1),
    status: z.enum(["waitingSafeBoundary", "switching", "active", "blocked"]),
    currentSelection: modelSelectionSchema.optional(),
    reasonCode: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type ExecutionFailoverTargetState = z.infer<typeof executionFailoverTargetStateSchema>;

export const executionFailoverStateSchema = z
  .object({
    revision: z.number().int().positive(),
    sourceCommandId: z.string().trim().min(1),
    modelSelection: modelSelectionSchema,
    foregroundExecutionId: z.string().trim().min(1).optional(),
    targets: z.array(executionFailoverTargetStateSchema).min(1).max(MAX_EXECUTION_FAILOVER_TARGETS),
    targetCount: z.number().int().positive().optional(),
    targetsTruncated: z.literal(true).optional(),
    lastTransition: executionFailoverTransitionSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((state, context) => {
    const keys = state.targets.map((target) => `${target.kind}:${target.id}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "execution failover targets must be unique",
      });
    }
    const hasTargetCount = state.targetCount !== undefined;
    const isTruncated = state.targetsTruncated === true;
    if (hasTargetCount !== isTruncated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasTargetCount ? "targetsTruncated" : "targetCount"],
        message: "truncated execution failover targets require count and marker together",
      });
    } else if (
      state.targetsTruncated === true &&
      state.targetCount !== undefined &&
      state.targetCount <= state.targets.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetCount"],
        message: "truncated execution failover target count must exceed projected targets",
      });
    }
  });
export type ExecutionFailoverState = z.infer<typeof executionFailoverStateSchema>;
