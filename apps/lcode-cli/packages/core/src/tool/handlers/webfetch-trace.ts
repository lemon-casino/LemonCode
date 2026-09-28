import {
  SessionEventType,
  type NetworkRequestStatusPayload,
  type TraceContext,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";

export async function emitNetworkRequestStatus(
  context: ToolExecutionContext,
  payload: NetworkRequestStatusPayload,
): Promise<void> {
  await context.emitEvent?.({
    id: crypto.randomUUID() as never,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.NetworkRequestStatus,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload,
  });
}

export function traceFromContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      toolCallId: context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
    },
  };
}
