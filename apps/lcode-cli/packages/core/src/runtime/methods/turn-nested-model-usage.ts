import { SessionEventType } from "../deps.js";
import type { ModelUsage, ToolExecutionResult, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export async function emitNestedModelUsageEvents(
  runtime: AgentRuntimeInternal,
  input: {
    events: RegularTurnLoopState["events"];
    results: ToolExecutionResult[];
    traceContext: TraceContext;
  },
): Promise<void> {
  for (const result of input.results) {
    const usage = extractNestedModelUsage(result.output);
    if (!usage) continue;

    const event = runtime.createEvent(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "tool_internal",
        usage,
        toolCallCount: 0,
      },
      input.traceContext,
    );
    await runtime.appendEvent(event, input.traceContext);
    input.events.push(event);
  }
}

function extractNestedModelUsage(output: unknown): ModelUsage | undefined {
  if (!isRecord(output) || !isRecord(output.modelUsage)) return undefined;
  const serverToolUse = isRecord(output.modelUsage.serverToolUse)
    ? {
        webFetchRequests: numberProperty(output.modelUsage.serverToolUse, "webFetchRequests"),
        webSearchRequests: numberProperty(output.modelUsage.serverToolUse, "webSearchRequests"),
      }
    : undefined;

  return {
    inputTokens: numberProperty(output.modelUsage, "inputTokens"),
    outputTokens: numberProperty(output.modelUsage, "outputTokens"),
    totalTokens: numberProperty(output.modelUsage, "totalTokens"),
    cacheReadTokens: numberProperty(output.modelUsage, "cacheReadTokens"),
    cacheWriteTokens: numberProperty(output.modelUsage, "cacheWriteTokens"),
    reasoningTokens: numberProperty(output.modelUsage, "reasoningTokens"),
    ...(serverToolUse ? { serverToolUse } : {}),
  };
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
