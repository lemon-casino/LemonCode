import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { ModelReasoningContentBlock, ModelToolCall, ModelUsage, ToolCallId } from "../deps.js";
import { normalizeStreamError, normalizeModelToolCallsForRuntime } from "../helpers/index.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";
import { getOrCreateReasoningBlock } from "./reasoning-stream.js";
import type { Model, ModelInvocationContext, ModelRequest } from "../deps.js";
import { validateModelStreamResult } from "./model-stream-result.js";

const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;

function hasToolInputLineBreak(value: string): boolean {
  return (
    value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r")
  );
}

interface ModelStreamRequest {
  contextUsageBreakdown: NonNullable<RuntimeModelTextResult["contextUsageBreakdown"]>;
  executionModelSelection: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  finishAssembly: () => void;
  model: Model;
  modelInvocationContext: ModelInvocationContext;
  modelRequest: ModelRequest;
}

export async function consumeModelTextStream(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
  request: ModelStreamRequest,
): Promise<RuntimeModelTextResult> {
  const {
    contextUsageBreakdown,
    executionModelSelection,
    finishAssembly,
    model,
    modelInvocationContext,
    modelRequest,
  } = request;
  let text = "";
  let finishReason = "unknown";
  let usage: ModelUsage = {};
  let providerMetadata: Record<string, unknown> | undefined;
  const reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  const toolCalls: ModelToolCall[] = [];
  const toolCallIds = new Set<string>();
  const toolInputDeltaBuffers = new Map<ToolCallId, string>();
  const publishStreamSnapshot = () => options.onStreamSnapshot?.({ reasoning, text });
  const streamingEventQueue = createModelStreamingEventQueue({
    events: options.events,
    runtime: this,
    traceContext: options.traceContext,
  });
  const enqueueStreamingEvent = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.maybeApplyBackpressure();
  };
  const enqueueStreamingEventAndDrain = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.drain();
  };
  const flushToolInputDelta = async (toolCallId: ToolCallId) => {
    const delta = toolInputDeltaBuffers.get(toolCallId);
    if (!delta) {
      return;
    }
    toolInputDeltaBuffers.delete(toolCallId);
    this.logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(options.traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await enqueueStreamingEvent({
      assistantMessageId: options.assistantMessageId,
      delta,
      done: false,
      kind: "tool_input_delta",
      toolCallId,
    });
  };
  const flushAllToolInputDeltas = async () => {
    for (const toolCallId of Array.from(toolInputDeltaBuffers.keys())) {
      await flushToolInputDelta(toolCallId);
    }
  };
  const appendToolInputDelta = async (toolCallId: ToolCallId, delta: string) => {
    if (!delta) {
      return;
    }
    const next = `${toolInputDeltaBuffers.get(toolCallId) ?? ""}${delta}`;
    toolInputDeltaBuffers.set(toolCallId, next);
    if (
      hasToolInputLineBreak(next) ||
      next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
    ) {
      // 实验原因：Write/Edit 的行数体验依赖 content 换行尽快到 UI。
      // 这里遇到真实/JSON 转义换行就 flush，同时保留超长单行兜底，
      // 避免没有换行的参数一直缓冲到 tool_input_end。
      await flushToolInputDelta(toolCallId);
    }
  };

  const modelStream = runWithModelInvocationContext(modelInvocationContext, () =>
    model.streamText(modelRequest),
  );
  finishAssembly();
  try {
    for await (const event of modelStream) {
      switch (event.type) {
        case "start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "start",
          });
          break;
        }

        case "text_start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_start",
          });
          break;
        }

        case "text_delta": {
          text += event.text;
          options.onStreamTextDelta?.(event.text);
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "text_delta",
          });
          break;
        }

        case "text_end": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_end",
          });
          break;
        }

        case "reasoning_start": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
          });
          if (event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_start",
          });
          break;
        }

        case "reasoning_delta": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
          });
          block.text += event.text;
          options.onStreamReasoningDelta?.(event.text);
          if (event.providerMetadata) block.providerOptions = event.providerMetadata;
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "reasoning_delta",
          });
          break;
        }

        case "reasoning_end": {
          const block = reasoningById.get(event.id);
          if (block && event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          reasoningById.delete(event.id);
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_end",
          });
          break;
        }

        case "tool_input_start": {
          const toolCallId = event.id as ToolCallId;
          toolInputDeltaBuffers.delete(toolCallId);
          this.logger?.debug("Model streaming tool input started", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_start",
            module: "core.runtime",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_start",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          break;
        }

        case "tool_input_delta": {
          await appendToolInputDelta(event.id as ToolCallId, event.delta);
          break;
        }

        case "tool_input_end": {
          await flushToolInputDelta(event.id as ToolCallId);
          this.logger?.debug("Model streaming tool input ended", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_end",
            module: "core.runtime",
            toolCallId: event.id,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_end",
            toolCallId: event.id as ToolCallId,
          });
          break;
        }

        case "tool_call": {
          const [toolCall] =
            normalizeModelToolCallsForRuntime([event.toolCall], {
              logger: this.logger,
              model: executionModelSelection,
              source: "streamText",
              traceContext: options.traceContext,
            }) ?? [];
          if (!toolCall) {
            break;
          }
          await flushToolInputDelta(toolCall.id as ToolCallId);
          if (toolCallIds.has(toolCall.id)) {
            // 防御原因：协议兼容或自定义 adapter 路径可能重复投递同 id 的 final tool_call；
            // runtime 按 id 去重，避免同一次响应内重复执行。
            break;
          }
          toolCallIds.add(toolCall.id);
          toolCalls.push(toolCall);
          this.logger?.debug("Model streaming tool call completed", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_call",
            inputKeys:
              typeof toolCall.input === "object" &&
              toolCall.input !== null &&
              !Array.isArray(toolCall.input)
                ? Object.keys(toolCall.input as Record<string, unknown>)
                : [],
            module: "core.runtime",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            input: toolCall.input,
            kind: "tool_call",
            toolCallId: toolCall.id as ToolCallId,
            toolName: toolCall.name,
          });
          options.onStreamToolCall?.(toolCall);
          break;
        }

        case "finish": {
          finishReason = event.finishReason;
          usage = event.usage;
          providerMetadata = event.providerMetadata;
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "finish",
          });
          break;
        }

        case "error": {
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "error",
          });
          // AI SDK 的 error chunk 常是 ProviderBusinessError 的 plain object（如 3007），
          // 若只做 JSON.stringify 会丢失 providerCode，UI 只能看到泛化的 stream 失败文案。
          throw normalizeStreamError(event.error);
        }
      }
    }
  } catch (error) {
    await streamingEventQueue.drain();
    throw error;
  }
  await streamingEventQueue.drain();

  validateModelStreamResult.call(this, options, {
    executionModelSelection,
    finishReason,
    providerMetadata,
    text,
    toolCalls,
    usage,
  });

  return {
    ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
    finishReason,
    providerMetadata,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}
