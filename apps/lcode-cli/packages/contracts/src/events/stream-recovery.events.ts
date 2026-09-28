import type { MessageId, PartId, ToolCallId } from "../interfaces/shared.js";
import type { ModelToolSideEffectScope } from "../model/index.js";

export type StreamingToolExecutionTiming = "end_of_stream" | "during_stream";

export type StreamingToolLedgerStatus =
  | "tool_input_streaming"
  | "tool_call_closed"
  | "tool_queued"
  | "tool_started"
  | "tool_result_committed"
  | "tool_cancelled"
  | "tool_abandoned"
  | "recovery_blocked";

export type StreamRecoveryAnchorKind =
  | "assistant_message"
  | "tool_result"
  | "tool_error"
  | "tool_cancelled";

/**
 * stream recovery 作废半截 assistant 输出时写在 transcript 上的标记。
 * 它只是一段被丢弃的 tail，不是本轮失败：压缩/fork 边界靠 error 字段把半截输出隔离，
 * 冷恢复与子会话终态判定必须把它当非终态跳过，和 live 投影一致。
 */
export const STREAM_RECOVERY_DISCARDED_ERROR_NAME = "StreamRecoveryDiscarded";
export const STREAM_RECOVERY_DISCARDED_FINISH = "stream_recovery_discarded";

export type StreamRecoveryFailureKind =
  | "provider_timeout"
  | "provider_network_error"
  | "provider_stream_error"
  | "provider_turn_failed"
  | "unknown";

export interface StreamingToolLedgerPayload {
  attemptId: string;
  assistantMessageId: MessageId;
  toolCallId: ToolCallId;
  toolName: string;
  status: StreamingToolLedgerStatus;
  executionTiming: StreamingToolExecutionTiming;
  input?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  startedAt?: Date;
  committedAt?: Date;
  resultPartId?: PartId;
  recoveryAnchorId?: string;
  blockedReason?: string;
}

export interface StreamRecoveryAnchorPayload {
  anchorId: string;
  attemptId: string;
  kind: StreamRecoveryAnchorKind;
  assistantMessageId?: MessageId;
  toolCallId?: ToolCallId;
  toolName?: string;
  resultPartId?: PartId;
  committedToolCallIds: ToolCallId[];
  committedAt: Date;
}

export interface StreamRecoveryStartedPayload {
  attemptId: string;
  assistantMessageId?: MessageId;
  failedRequestId?: string;
  failureKind: StreamRecoveryFailureKind;
  message: string;
  retryNumber: number;
  maxRetries: number;
}

export interface StreamRecoveryAnchorSelectedPayload {
  attemptId: string;
  anchorId: string;
  reason: "latest_committed_tool_result" | "latest_committed_message" | "no_tool_committed";
  committedToolCallIds: ToolCallId[];
}

export interface StreamRecoveryTailDiscardedPayload {
  attemptId: string;
  anchorId: string;
  assistantMessageId?: MessageId;
  discardedTextBytes: number;
  discardedReasoningBytes: number;
  discardedToolCallIds: ToolCallId[];
}

export interface StreamRecoveryRetryStartedPayload {
  attemptId: string;
  anchorId: string;
  failedRequestId?: string;
  retryNumber: number;
  maxRetries: number;
  streamMode: "sse";
}

export interface StreamRecoveryBlockedPayload {
  attemptId: string;
  toolCallId?: ToolCallId;
  toolName?: string;
  reason: "running_side_effect" | "unknown_side_effect" | "non_retryable_failure";
  message: string;
}

export interface StreamingToolLedgerProjectionInfo {
  attemptId: string;
  assistantMessageId: MessageId;
  toolCallId: ToolCallId;
  toolName: string;
  status: StreamingToolLedgerStatus;
  executionTiming: StreamingToolExecutionTiming;
  input?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  startedAt?: Date;
  committedAt?: Date;
  resultPartId?: PartId;
  recoveryAnchorId?: string;
  blockedReason?: string;
  updatedAt: Date;
}

export interface StreamRecoveryAnchorProjectionInfo {
  anchorId: string;
  attemptId: string;
  kind: StreamRecoveryAnchorKind;
  assistantMessageId?: MessageId;
  toolCallId?: ToolCallId;
  toolName?: string;
  resultPartId?: PartId;
  committedToolCallIds: ToolCallId[];
  committedAt: Date;
  updatedAt: Date;
}
