// ============================================================
// Compact Contracts - boundary payloads and active-chain helpers
// ============================================================

import { z } from "zod";

import type { MessageId, PartId, ToolCallId, TraceId, TurnId } from "../interfaces/shared.js";

export const CompactTrigger = {
  Manual: "manual",
  Auto: "auto",
  Partial: "partial",
  Reactive: "reactive",
  SessionMemory: "session_memory",
} as const;

export type CompactTrigger = (typeof CompactTrigger)[keyof typeof CompactTrigger];

export const MicrocompactTrigger = {
  TimeBased: "time_based",
  TokenPressure: "token_pressure",
} as const;

export type MicrocompactTrigger = (typeof MicrocompactTrigger)[keyof typeof MicrocompactTrigger];

export const MicrocompactStrategy = {
  LocalToolResultClear: "local_tool_result_clear",
} as const;

export type MicrocompactStrategy = (typeof MicrocompactStrategy)[keyof typeof MicrocompactStrategy];

export const CompactPhase = {
  StandaloneTurn: "standalone_turn",
  PreRequest: "pre_request",
  MidTurn: "mid_turn",
  Reactive: "reactive",
} as const;

export type CompactPhase = (typeof CompactPhase)[keyof typeof CompactPhase];

export const CompactReason = {
  UserRequested: "user_requested",
  ContextLimit: "context_limit",
  ModelDownshift: "model_downshift",
  ProviderOverflow: "provider_overflow",
} as const;

export type CompactReason = (typeof CompactReason)[keyof typeof CompactReason];

export const CompactStatus = {
  Started: "started",
  BoundaryCreated: "boundary_created",
  SummaryCreated: "summary_created",
  Completed: "completed",
  Failed: "failed",
} as const;

export type CompactStatus = (typeof CompactStatus)[keyof typeof CompactStatus];

export const CompactTimelineStatus = {
  Started: "started",
  Retrying: "retrying",
  Skipped: "skipped",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;

export type CompactTimelineStatus =
  (typeof CompactTimelineStatus)[keyof typeof CompactTimelineStatus];

export const CompactTimelineDisplay = {
  Separator: "separator",
} as const;

export type CompactTimelineDisplay =
  (typeof CompactTimelineDisplay)[keyof typeof CompactTimelineDisplay];

export const CompactFailureReason = {
  NotEnoughMessages: "not_enough_messages",
  PromptTooLong: "prompt_too_long",
  NoSummary: "no_summary",
  ApiError: "api_error",
  Cancelled: "cancelled",
  HookFailed: "hook_failed",
  RelinkFailed: "relink_failed",
  Unknown: "unknown",
} as const;

export type CompactFailureReason = (typeof CompactFailureReason)[keyof typeof CompactFailureReason];

const compactTimelinePayloadInputSchema = z
  .object({
    operationId: z.string().min(1),
    messageId: z.string().min(1),
    partId: z.string().min(1).optional(),
    status: z.enum([
      CompactTimelineStatus.Started,
      CompactTimelineStatus.Retrying,
      CompactTimelineStatus.Skipped,
      CompactTimelineStatus.Completed,
      CompactTimelineStatus.Failed,
      CompactTimelineStatus.Interrupted,
    ]),
    trigger: z.enum([
      CompactTrigger.Manual,
      CompactTrigger.Auto,
      CompactTrigger.Partial,
      CompactTrigger.Reactive,
      CompactTrigger.SessionMemory,
    ]),
    phase: z
      .enum([
        CompactPhase.StandaloneTurn,
        CompactPhase.PreRequest,
        CompactPhase.MidTurn,
        CompactPhase.Reactive,
      ])
      .optional(),
    compactReason: z
      .enum([
        CompactReason.UserRequested,
        CompactReason.ContextLimit,
        CompactReason.ModelDownshift,
        CompactReason.ProviderOverflow,
      ])
      .optional(),
    display: z.literal(CompactTimelineDisplay.Separator).default(CompactTimelineDisplay.Separator),
    text: z.string().min(1).optional(),
    replace: z.boolean().optional(),
    reason: z.string().min(1).optional(),
    boundaryId: z.string().min(1).optional(),
    summaryMessageId: z.string().min(1).optional(),
    // compact 覆盖前缀的最后一条 transcript message；live/cold edit 判定必须同源。
    tailStartMessageId: z.string().min(1).optional(),
    sourceCommandId: z.string().min(1).optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const compactTimelinePayloadSchema = compactTimelinePayloadInputSchema.transform(
  ({ text: _legacyText, ...payload }) => payload,
);

export type CompactTimelinePayload = Omit<
  z.infer<typeof compactTimelinePayloadSchema>,
  "messageId" | "partId" | "summaryMessageId" | "tailStartMessageId"
> & {
  messageId: MessageId;
  partId?: PartId;
  summaryMessageId?: MessageId;
  tailStartMessageId?: MessageId;
};

export function parseCompactTimelinePayload(input: unknown): CompactTimelinePayload {
  return compactTimelinePayloadSchema.parse(input) as CompactTimelinePayload;
}

export const compactPreservedSegmentSchema = z
  .object({
    headMessageId: z.string().min(1),
    anchorMessageId: z.string().min(1),
    tailMessageId: z.string().min(1),
  })
  .strict();

export type CompactPreservedSegment = {
  headMessageId: MessageId;
  anchorMessageId: MessageId;
  tailMessageId: MessageId;
};

export const compactBoundaryPayloadSchema = z
  .object({
    boundaryId: z.string().min(1),
    trigger: z.enum([
      CompactTrigger.Manual,
      CompactTrigger.Auto,
      CompactTrigger.Partial,
      CompactTrigger.Reactive,
      CompactTrigger.SessionMemory,
    ]),
    phase: z
      .enum([
        CompactPhase.StandaloneTurn,
        CompactPhase.PreRequest,
        CompactPhase.MidTurn,
        CompactPhase.Reactive,
      ])
      .optional(),
    compactReason: z
      .enum([
        CompactReason.UserRequested,
        CompactReason.ContextLimit,
        CompactReason.ModelDownshift,
        CompactReason.ProviderOverflow,
      ])
      .optional(),
    summarySource: z.enum(["model", "session_memory"]).optional(),
    preCompactTokenCount: z.number().int().nonnegative(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    autoCompactThreshold: z.number().int().nonnegative().optional(),
    willRetriggerNextTurn: z.boolean().optional(),
    summarizedMessageCount: z.number().int().nonnegative(),
    keptMessageCount: z.number().int().nonnegative().optional(),
    lastSummarizedMessageId: z.string().min(1).optional(),
    preservedSegment: compactPreservedSegmentSchema.optional(),
    summaryMessageIds: z.array(z.string().min(1)).default([]),
    attachmentMessageIds: z.array(z.string().min(1)).optional(),
    hookResultMessageIds: z.array(z.string().min(1)).optional(),
    preCompactDiscoveredTools: z.array(z.string().min(1)).optional(),
    customInstructions: z.boolean().optional(),
    traceId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
    parentSpanId: z.string().min(1).optional(),
  })
  .strict();

export type CompactBoundaryPayload = Omit<
  z.infer<typeof compactBoundaryPayloadSchema>,
  "lastSummarizedMessageId" | "preservedSegment" | "summaryMessageIds" | "traceId" | "turnId"
> & {
  lastSummarizedMessageId?: MessageId;
  preservedSegment?: CompactPreservedSegment;
  summaryMessageIds: MessageId[];
  traceId: TraceId;
  turnId?: TurnId;
};

export const microcompactBoundaryPayloadSchema = z
  .object({
    trigger: z.enum([MicrocompactTrigger.TimeBased, MicrocompactTrigger.TokenPressure]),
    strategy: z.enum([MicrocompactStrategy.LocalToolResultClear]),
    preMicrocompactTokenCount: z.number().int().nonnegative(),
    postMicrocompactTokenCount: z.number().int().nonnegative(),
    tokensSaved: z.number().int().nonnegative(),
    clearedToolCallIds: z.array(z.string().min(1)),
    keptToolCallIds: z.array(z.string().min(1)),
    clearedMessageCount: z.number().int().nonnegative(),
    traceId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  })
  .strict();

export type MicrocompactBoundaryPayload = Omit<
  z.infer<typeof microcompactBoundaryPayloadSchema>,
  "clearedToolCallIds" | "keptToolCallIds" | "traceId" | "turnId"
> & {
  clearedToolCallIds: ToolCallId[];
  keptToolCallIds: ToolCallId[];
  traceId: TraceId;
  turnId?: TurnId;
};

export interface CompactSummaryPayload {
  boundaryId: string;
  summary: string;
  summaryMessageId: MessageId;
  source: "model" | "session_memory";
}

export interface CompactProjectionInfo {
  boundaryId: string;
  trigger: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  compactedAt: Date;
  preCompactTokenCount: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  summarizedMessageCount: number;
  keptMessageCount?: number;
  willRetriggerNextTurn?: boolean;
}

export interface CompactContextItem {
  id: string;
  compactBoundary?: CompactBoundaryPayload;
  isCompactSummary?: boolean;
}

export interface CompactPostContext<T> {
  boundaryMarker: T;
  summaryMessages: readonly T[];
  messagesToKeep?: readonly T[];
  attachments?: readonly T[];
  hookResults?: readonly T[];
}

export function parseCompactBoundaryPayload(input: unknown): CompactBoundaryPayload {
  return compactBoundaryPayloadSchema.parse(input) as CompactBoundaryPayload;
}

export function parseMicrocompactBoundaryPayload(input: unknown): MicrocompactBoundaryPayload {
  return microcompactBoundaryPayloadSchema.parse(input) as MicrocompactBoundaryPayload;
}

export function isCompactBoundaryItem(item: unknown): item is CompactContextItem & {
  compactBoundary: CompactBoundaryPayload;
} {
  if (typeof item !== "object" || item === null || !("compactBoundary" in item)) {
    return false;
  }

  const boundary = (item as { compactBoundary?: unknown }).compactBoundary;
  return compactBoundaryPayloadSchema.safeParse(boundary).success;
}

export function buildPostCompactItems<T>(postContext: CompactPostContext<T>): T[] {
  return [
    postContext.boundaryMarker,
    ...postContext.summaryMessages,
    ...(postContext.messagesToKeep ?? []),
    ...(postContext.attachments ?? []),
    ...(postContext.hookResults ?? []),
  ];
}

export function getItemsAfterLastCompactBoundary<T>(
  items: readonly T[],
  isBoundary: (item: T) => boolean = (item) => isCompactBoundaryItem(item),
): T[] {
  const boundaryIndex = items.findLastIndex(isBoundary);
  if (boundaryIndex < 0) {
    return [...items];
  }
  return items.slice(boundaryIndex);
}

export function annotateBoundaryWithPreservedSegment<T extends CompactContextItem>(
  boundary: T,
  preservedSegment: CompactPreservedSegment,
): T {
  if (!boundary.compactBoundary) {
    throw new Error("Cannot annotate a compact boundary on an item without compactBoundary");
  }

  return {
    ...boundary,
    compactBoundary: {
      ...boundary.compactBoundary,
      preservedSegment,
    },
  };
}
