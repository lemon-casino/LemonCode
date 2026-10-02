import { CoreErrorType, SessionEventType, traceContextToLogContext } from "../deps.js";
import type { SessionEvent, ToolCallId, TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { usageStoreFor } from "./usage-observability-common.js";

export async function recordToolUsageFromEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const payload = event.payload as Record<string, unknown>;
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) return;

  const toolName = stringValue(payload.toolName) ?? "unknown";
  const metadata = runtime.registry.get(toolName)?.metadata;
  const startedAt = event.timestamp.getTime();
  const base = {
    id: toolUsageId(runtime.sessionId, toolCallId),
    sessionID: runtime.sessionId,
    turnID: event.turnId ?? traceContext.turnId,
    traceID: event.traceId ?? traceContext.traceId,
    toolCallID: toolCallId as ToolCallId,
    toolName,
    sideEffectScope: metadata?.sideEffectScope,
    readOnly: metadata?.readOnly,
    destructive: metadata?.destructive,
    startedAt,
  };

  try {
    if (event.type === SessionEventType.ToolCallScheduled) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: "none",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionRequested) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: "requested",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionResolved) {
      const decision = stringValue(payload.decision);
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: decision === "deny" ? "denied" : "allowed",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionDenied) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "error",
        approvalStatus: "denied",
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallStarted) {
      const payloadStartedAt =
        payload.startedAt instanceof Date ? payload.startedAt.getTime() : startedAt;
      await usageStore.upsertToolUsage({
        ...base,
        startedAt: payloadStartedAt,
        status: "running",
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallProgress) {
      const outputBytes = numberValue(payload.outputBytes);
      const stdoutBytes = numberValue(payload.stdoutBytes);
      const stderrBytes = numberValue(payload.stderrBytes);
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        firstOutputAt:
          outputBytes > 0 || stdoutBytes > 0 || stderrBytes > 0
            ? event.timestamp.getTime()
            : undefined,
        outputBytes,
        stdoutBytes,
        stderrBytes,
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallResult) {
      const result = payload.result as Record<string, unknown> | undefined;
      const performance = result?.perf as Record<string, unknown> | undefined;
      const detail = performance?.detail as Record<string, unknown> | undefined;
      const command =
        detail?.kind === "command"
          ? (detail.command as Record<string, unknown> | undefined)
          : undefined;
      await usageStore.upsertToolUsage({
        ...base,
        status: "completed",
        completedAt: event.timestamp.getTime(),
        durationMs: numberValue(payload.duration),
        exitCode: numberValue(command?.exitCode),
        outputBytes: numberValue(result?.returnedBytes ?? result?.originalBytes),
        truncated: result?.truncated === true,
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallError) {
      const error = payload.error as Record<string, unknown> | undefined;
      const errorType = stringValue(error?.type) ?? CoreErrorType.ToolExecutionFailed;
      await usageStore.upsertToolUsage({
        ...base,
        status: errorType.includes("cancel") ? "cancelled" : "error",
        completedAt: event.timestamp.getTime(),
        cancelledByUser: errorType.includes("cancel"),
        errorType,
        errorCode: stringValue(error?.code),
        errorMessage: stringValue(error?.message),
      });
    }
  } catch (error) {
    runtime.logger?.warn("Usage tool fact write failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.tool.write.failed",
      module: "core.runtime",
      status: "failed",
      toolCallId,
    });
  }
}

function toolUsageId(sessionId: string, toolCallId: string): string {
  return `usage_tool_${sessionId}_${toolCallId}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
