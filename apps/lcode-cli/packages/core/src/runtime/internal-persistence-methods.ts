import type { RuntimeInputPresentation } from "@lcode/contracts";
import type {
  CompactTimelineStatus,
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MessageId,
  MessageWithParts,
  MessagePart,
  MessageVisibility,
  Model,
  ModelSelection,
  PartId,
  SessionEvent,
  SessionEventType,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SyntheticUserMessageSource,
  TimelinePartDraft,
  TraceContext,
  TurnExecutionKind,
  TurnInputIntentMetadata,
} from "./deps.js";
import type { CompactTimelineContext, ResolvedTurnAttachment } from "./types.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";

export interface AgentRuntimePersistenceMethods {
  createEvent(type: SessionEventType, payload: unknown, traceContext: TraceContext): SessionEvent;
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  notifyEventSinks(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  ensureSessionPersisted(input: string, traceContext: TraceContext): Promise<void>;
  buildCompactTimelinePayload(
    timeline: CompactTimelineContext,
    update: {
      attempt?: number;
      boundaryId?: string;
      endedAt?: number;
      maxAttempts?: number;
      postCompactTokenCount?: number;
      reason?: string;
      replace?: boolean;
      status: CompactTimelineStatus;
      summaryMessageId?: MessageId;
      tailStartMessageId?: MessageId;
      truePostCompactTokenCount?: number;
    },
  ): CompactTimelinePayload;
  persistCompactTimeline(
    payload: CompactTimelinePayload,
    traceContext: TraceContext,
  ): Promise<void>;
  finishCompactTimelineFailure(options: {
    abortSignal?: AbortSignal;
    attempt?: number;
    error: unknown;
    events: SessionEvent[];
    maxAttempts?: number;
    timeline: CompactTimelineContext;
    traceContext: TraceContext;
  }): Promise<void>;
  recoverInterruptedCompactTimelines(
    messages: MessageWithParts[],
    traceContext: TraceContext,
  ): Promise<number>;
  persistCompactSummary(
    messageID: MessageId,
    content: string,
    summary: string,
    compactBoundary: CompactBoundaryPayload,
    traceContext: TraceContext,
    options?: {
      model?: Model;
      operationId?: string;
      postCompactReminderEntries?: readonly RuntimeMessageEntry[];
    },
  ): Promise<void>;
  persistUserPrompt(
    messageID: MessageId,
    input: string,
    attachments: ResolvedTurnAttachment[] | undefined,
    traceContext: TraceContext,
    options?: {
      steerDelivery?: "guide" | "queue";
      inputPresentation?: RuntimeInputPresentation;
      sessionInputId?: string;
      sourceCommandId?: string;
      clientId?: string;
      intent?: TurnInputIntentMetadata;
      executionKind?: TurnExecutionKind;
      epilogueStart?: number;
    },
  ): Promise<void>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  persistPendingModelChangeTimeline(traceContext: TraceContext): Promise<void>;
  persistSyntheticUserNotice(
    messageID: MessageId,
    text: string,
    traceContext: TraceContext,
  ): Promise<void>;
  persistSyntheticUserNoticeForSession(options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    text: string;
    traceContext: TraceContext;
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  }): Promise<void>;
  persistAssistantTimelinePartForSession(options: {
    sessionId: SessionId;
    messageID?: MessageId;
    partID?: PartId;
    parentID?: MessageId;
    created?: number;
    completed?: number;
    finish?: string;
    timeline: TimelinePartDraft;
    traceContext: TraceContext;
  }): Promise<{ messageID: MessageId; partID: PartId }>;
  persistAssistantMessage(
    messageID: MessageId,
    parentID: MessageId,
    created: number,
    update:
      | {
          completed?: number;
          error?: { name: string; data?: Record<string, unknown> };
          finish?: string;
          tokens?: unknown;
        }
      | undefined,
    traceContext: TraceContext,
    model?: Model,
  ): Promise<void>;
  persistMessage(
    input: Parameters<SessionStorePort["saveMessage"]>[0],
    traceContext: TraceContext,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void>;
  persistPart(
    input: MessagePart,
    traceContext: TraceContext,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void>;
  rebuildProjection(): Promise<SessionProjection>;
}
