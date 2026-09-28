import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import type React from "react";
import type { Message } from "./app-model.js";
import { applyModelStreamingEvent } from "./app-model-streaming.js";
import { applyToolTranscriptEvent } from "./app-tool-transcript.js";
import { appendAgentResult } from "./app-submit.js";
import { finalizeStreamProjectedMessages } from "./app-transcript-stream.js";
import { isSubagentToolMirror } from "./app-subagent-events.js";
import type { TuiSubagentTranscriptSnapshot } from "./types.js";

export type SubagentTranscript = {
  sessionId: string;
  sequenceNumber: number;
  messages: Message[];
  liveModelText: string;
  toolNamesById: Map<string, string>;
  assistantMessageIdsByToolCallId: Map<string, string>;
};

export function hydrateSubagentTranscript(
  snapshot: TuiSubagentTranscriptSnapshot,
  workspaceDirectory?: string,
): SubagentTranscript {
  let state: SubagentTranscript = {
    sessionId: snapshot.sessionId,
    sequenceNumber: 0,
    messages: appendAgentResult(
      [],
      { response: "", restoredMessages: snapshot.messages },
      { workspaceDirectory },
    ),
    liveModelText: "",
    toolNamesById: new Map(),
    assistantMessageIdsByToolCallId: new Map(),
  };
  const replayIds = new Set(snapshot.replayMessageIds);
  for (const event of snapshot.events) {
    // Completed replies already exist in persisted history. Replaying historical
    // turn_complete/assistant_message would append previous turns a second time.
    if (event.type !== SessionEventType.ModelStreaming && !event.type.startsWith("tool_call_"))
      continue;
    const payload = event.payload as Record<string, unknown>;
    // Completed history without retained stream events is already in messages.
    if (
      event.type === SessionEventType.ModelStreaming &&
      !replayIds.has(String(payload.assistantMessageId))
    )
      continue;
    state = applySubagentTranscriptEvent(state, event, workspaceDirectory);
  }
  return { ...state, sequenceNumber: snapshot.sequenceNumber };
}

/** This reducer can update only transcript data; it has no composer/runtime controls. */
export function applySubagentTranscriptEvent(
  state: SubagentTranscript,
  event: SessionEvent,
  workspaceDirectory?: string,
): SubagentTranscript {
  if (
    event.sessionId !== state.sessionId ||
    isSubagentToolMirror(event) ||
    event.sequenceNumber <= state.sequenceNumber
  )
    return state;
  const next = { ...state, sequenceNumber: event.sequenceNumber };
  const payload = event.payload as Record<string, unknown>;
  const setMessages = (action: React.SetStateAction<Message[]>) => {
    next.messages = typeof action === "function" ? action(next.messages) : action;
  };
  if (event.type === SessionEventType.ModelStreaming) {
    applyModelStreamingEvent(payload, {
      setMessages,
      assistantMessageIdsByToolCallId: next.assistantMessageIdsByToolCallId,
      setLiveModelText: (action) => {
        next.liveModelText = typeof action === "function" ? action(next.liveModelText) : action;
      },
      setStatus: () => {},
    });
  } else if (event.type.startsWith("tool_call_")) {
    applyToolTranscriptEvent(event, {
      setMessages,
      toolNamesById: next.toolNamesById,
      assistantMessageIdsByToolCallId: next.assistantMessageIdsByToolCallId,
      workspaceDirectory,
    });
    const result = payload.result as Record<string, unknown> | undefined;
    const output =
      typeof result?.content === "string"
        ? result.content
        : [payload.stdoutTail, payload.stderrTail]
            .filter((value): value is string => typeof value === "string")
            .join("\n");
    if (output)
      next.messages = next.messages.map((message) => ({
        ...message,
        parts: message.parts?.map((part) =>
          part.type === "tool" && part.toolCallId === payload.toolCallId
            ? { ...part, output }
            : part,
        ),
      }));
  } else if (event.type === SessionEventType.AssistantMessage) {
    appendResponse(next, payload.content);
  } else if (
    event.type === SessionEventType.TurnComplete ||
    event.type === SessionEventType.TurnError
  ) {
    next.messages = finalizeStreamProjectedMessages(next.messages);
    if (next.liveModelText) {
      next.messages = [...next.messages, { role: "agent", content: next.liveModelText }];
      next.liveModelText = "";
    }
    if (event.type === SessionEventType.TurnComplete) appendResponse(next, payload.response);
    if (event.type === SessionEventType.TurnError) {
      const error = payload.error as Record<string, unknown> | undefined;
      if (typeof error?.message === "string")
        next.messages = [...next.messages, { role: "system", content: error.message }];
    }
  }
  return next;
}

function appendResponse(state: SubagentTranscript, response: unknown): void {
  if (typeof response !== "string" || !response.trim()) return;
  const last = state.messages.filter((message) => message.role === "agent").at(-1);
  const text = last?.parts?.length
    ? last.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : last?.content;
  if (text?.trim() !== response.trim())
    state.messages = [...state.messages, { role: "agent", content: response }];
}
