import type React from "react";
import type { Message } from "./app-model.js";
import {
  appendStreamingTextDelta,
  appendStreamingThoughtDelta,
  markStreamingMessageComplete,
  markStreamingThoughtComplete,
} from "./app-transcript-stream.js";
import { stringField } from "./state.js";

export function applyModelStreamingEvent(
  payload: Record<string, unknown>,
  handlers: {
    assistantMessageIdsByToolCallId: Map<string, string>;
    setLiveModelText: React.Dispatch<React.SetStateAction<string>>;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setStatus: (status: string) => void;
  },
): void {
  const kind = stringField(payload, "kind");
  const delta = stringField(payload, "delta") ?? "";
  if (kind === "reasoning_start") {
    handlers.setStatus("Streaming model reasoning...");
    return;
  }
  if (kind === "reasoning_delta") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) =>
        appendStreamingThoughtDelta(current, assistantMessageId, delta),
      );
    }
    handlers.setStatus("Streaming model reasoning...");
    return;
  }
  if (kind === "reasoning_end") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) => markStreamingThoughtComplete(current, assistantMessageId));
    }
    handlers.setStatus("Model reasoning received.");
    return;
  }
  if (kind === "tool_call") {
    rememberStreamingToolMessage(payload, handlers.assistantMessageIdsByToolCallId);
    handlers.setStatus(`Tool ${stringField(payload, "toolName") ?? "tool"} pending.`);
    return;
  }
  if (kind === "tool_input_start" || kind === "tool_input_delta" || kind === "tool_input_end") {
    // provider tool-input deltas are JSON arguments for a future tool call, not assistant text.
    handlers.setStatus(`Preparing tool ${stringField(payload, "toolName") ?? "tool"}...`);
    return;
  }
  if (kind === "text_delta" || (!kind && delta)) {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      // a global live text buffer renders below tool rows; assistant-scoped deltas
      // keep text/tool/text in the provider's original transcript order.
      handlers.setMessages((current) =>
        appendStreamingTextDelta(current, assistantMessageId, delta),
      );
    } else {
      handlers.setLiveModelText((current) => `${current}${delta}`);
    }
    handlers.setStatus("Streaming model response...");
    return;
  }
  if (kind === "finish") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) => markStreamingMessageComplete(current, assistantMessageId));
    }
    handlers.setStatus("Model response received.");
  }
}

function rememberStreamingToolMessage(
  payload: Record<string, unknown>,
  assistantMessageIdsByToolCallId: Map<string, string>,
): void {
  const toolCallId = stringField(payload, "toolCallId");
  const assistantMessageId = stringField(payload, "assistantMessageId");
  if (toolCallId && assistantMessageId) {
    assistantMessageIdsByToolCallId.set(toolCallId, assistantMessageId);
  }
}
