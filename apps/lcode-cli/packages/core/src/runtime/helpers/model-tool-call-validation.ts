import { CoreErrorType, createCoreError, traceContextToLogContext } from "../deps.js";
import type { Logger, Model, ModelToolCall, ToolCall, TraceContext } from "../deps.js";

interface ModelToolCallValidationContext {
  logger?: Logger;
  model: Pick<Model, "providerId" | "modelId">;
  source: string;
  traceContext: TraceContext;
}

export function normalizeModelToolCallsForRuntime(
  toolCalls: readonly ModelToolCall[] | undefined,
  context: ModelToolCallValidationContext,
): ModelToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((toolCall, index) => ({
    ...toolCall,
    name: normalizeRuntimeModelToolName(toolCall.name, {
      ...context,
      providerExecuted: toolCall.providerExecuted,
      toolCallId: toolCall.id,
      toolCallIndex: index,
    }),
  }));
}

export function requireRuntimeToolCallName(
  toolCall: Pick<ModelToolCall | ToolCall, "id" | "name">,
  context: ModelToolCallValidationContext,
): string {
  return requireRuntimeToolName(toolCall.name, {
    ...context,
    toolCallId: toolCall.id,
  });
}

function requireRuntimeToolName(
  value: unknown,
  context: ModelToolCallValidationContext & {
    toolCallId?: string;
    toolCallIndex?: number;
  },
): string {
  const toolName = typeof value === "string" ? value.trim() : "";
  if (toolName) {
    return toolName;
  }

  return throwInvalidRuntimeToolName(context);
}

function normalizeRuntimeModelToolName(
  value: unknown,
  context: ModelToolCallValidationContext & {
    providerExecuted?: boolean;
    toolCallId?: string;
    toolCallIndex?: number;
  },
): string {
  if (typeof value === "string") {
    const toolName = value.trim();
    if (toolName) {
      return toolName;
    }
    if (
      context.providerExecuted !== true &&
      typeof context.toolCallId === "string" &&
      context.toolCallId.trim().length > 0
    ) {
      // Adapter 后仍可能存在自定义 Model 实现；runtime admission 必须与
      // Adapter 一致保留可闭合的 client-executed 空名，而不是再次把 turn 截断。
      return value;
    }
  }

  return throwInvalidRuntimeToolName(context);
}

function throwInvalidRuntimeToolName(
  context: ModelToolCallValidationContext & {
    toolCallId?: string;
    toolCallIndex?: number;
  },
): never {
  const logContext = {
    ...traceContextToLogContext(context.traceContext),
    event: "model.invalid_tool_call",
    module: "core.runtime",
    model: `${context.model.providerId}/${context.model.modelId}`,
    modelId: context.model.modelId,
    providerId: context.model.providerId,
    source: context.source,
    status: "failed" as const,
    toolCallId: context.toolCallId,
    toolCallIndex: context.toolCallIndex,
  };
  context.logger?.warn("Model returned invalid tool call", logContext);

  throw createCoreError(
    CoreErrorType.ModelError,
    "Model returned an invalid tool call: tool name is empty.",
    {
      context: logContext,
      recoverable: true,
      retryable: false,
    },
  );
}
