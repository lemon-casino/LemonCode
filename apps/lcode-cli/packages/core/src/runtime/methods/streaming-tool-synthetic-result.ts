import { SessionEventType, createPartId } from "../deps.js";
import type {
  ModelToolCall,
  SessionEvent,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import { toRecordInput } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";

const STREAM_RECOVERY_TOOL_ERROR_TYPE = "stream_recovery_interrupted_tool";

const TOOL_NOT_EXECUTED_MESSAGE =
  "Tool execution was interrupted during streaming recovery before this tool was executed. Treat this tool call as failed and do not retry blindly.";

const TOOL_STATE_UNKNOWN_MESSAGE =
  "Tool execution was interrupted during streaming recovery before a result was committed. Side effects may be unknown; inspect current state before retrying.";

type SyntheticStreamedToolReason = "not_executed" | "unknown_execution_state";

export function createSyntheticStreamedToolResult(
  toolCall: ModelToolCall,
  reason: SyntheticStreamedToolReason,
): StreamedToolExecutionResult {
  const now = new Date();
  const message =
    reason === "not_executed" ? TOOL_NOT_EXECUTED_MESSAGE : TOOL_STATE_UNKNOWN_MESSAGE;
  const result: ToolExecutionResult = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    modelContent: message,
    error: {
      type: STREAM_RECOVERY_TOOL_ERROR_TYPE,
      message,
    },
    durationMs: 0,
    startedAt: now,
    completedAt: now,
  };

  return {
    input: toRecordInput(toolCall.input),
    ledgerRecorded: false,
    partID: createPartId(),
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

export async function emitSyntheticStreamedToolError(
  runtime: AgentRuntimeInternal,
  events: SessionEvent[],
  traceContext: TraceContext,
  result: ToolExecutionResult,
): Promise<void> {
  if (!result.error) return;
  const event = runtime.createEvent(
    SessionEventType.ToolCallError,
    {
      toolCallId: result.toolCallId as ToolCallId,
      error: result.error,
    },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}
