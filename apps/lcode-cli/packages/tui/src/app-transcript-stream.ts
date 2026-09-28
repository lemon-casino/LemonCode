import type { Message, TextTranscriptPart, ThoughtTranscriptPart } from "./app-model.js";

const AGENT_ROLE = "agent";
const STREAMING_THOUGHT_STATUS = "thinking";
const COMPLETED_THOUGHT_STATUS = "thought";

export function appendStreamingTextDelta(
  messages: Message[],
  assistantMessageId: string,
  delta: string,
): Message[] {
  if (delta.length === 0) return messages;

  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== assistantMessageId) return message;
    found = true;
    return appendTextPart(message, delta);
  });

  if (found) return updated;
  return [
    ...updated,
    appendTextPart(
      {
        content: "",
        id: assistantMessageId,
        parts: [],
        role: AGENT_ROLE,
        streamProjected: true,
        streaming: true,
      },
      delta,
    ),
  ];
}

export function markStreamingMessageComplete(
  messages: Message[],
  assistantMessageId: string,
): Message[] {
  return messages.map((message) =>
    message.id === assistantMessageId
      ? { ...completeThoughtParts(message), streaming: false }
      : message,
  );
}

export function finalizeStreamProjectedMessages(messages: Message[]): Message[] {
  return messages.map((message) =>
    message.streamProjected && message.streaming
      ? { ...completeThoughtParts(message), streaming: false }
      : message,
  );
}

export function appendStreamingThoughtDelta(
  messages: Message[],
  assistantMessageId: string,
  delta: string,
): Message[] {
  if (delta.length === 0) return messages;

  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== assistantMessageId) return message;
    found = true;
    return appendThoughtPart(message, delta);
  });

  if (found) return updated;
  return [
    ...updated,
    appendThoughtPart(
      {
        content: "",
        id: assistantMessageId,
        parts: [],
        role: AGENT_ROLE,
        streamProjected: true,
        streaming: true,
      },
      delta,
    ),
  ];
}

export function markStreamingThoughtComplete(
  messages: Message[],
  assistantMessageId: string,
): Message[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? completeActiveThoughtPart(message) : message,
  );
}

export function projectedTranscriptHasResponse(messages: Message[], response: string): boolean {
  const normalized = response.trim();
  const projectedMessages = messages.filter((message) => message.streamProjected);
  if (normalized.length === 0) return projectedMessages.length > 0;
  const lastProjected = projectedMessages.at(-1);
  return lastProjected ? transcriptText(lastProjected).trim() === normalized : false;
}

function appendTextPart(message: Message, delta: string): Message {
  const parts = [...(message.parts ?? [])];
  const last = parts.at(-1);
  if (last?.type === "text" && last.streamProjected) {
    parts[parts.length - 1] = {
      ...last,
      text: `${last.text}${delta}`,
    };
  } else {
    parts.push({
      streamProjected: true,
      text: delta,
      type: "text",
    } satisfies TextTranscriptPart);
  }

  return {
    ...message,
    content: "",
    parts,
    role: AGENT_ROLE,
    streamProjected: true,
    streaming: true,
  };
}

function appendThoughtPart(message: Message, delta: string): Message {
  const parts = [...(message.parts ?? [])];
  const last = parts.at(-1);
  if (last?.type === "thought" && last.status === STREAMING_THOUGHT_STATUS) {
    parts[parts.length - 1] = {
      ...last,
      contentCharCount: last.contentCharCount + delta.length,
      text: `${last.text}${delta}`,
    };
  } else {
    parts.push({
      contentCharCount: delta.length,
      status: STREAMING_THOUGHT_STATUS,
      streamProjected: true,
      text: delta,
      type: "thought",
    } satisfies ThoughtTranscriptPart);
  }

  return {
    ...message,
    content: "",
    parts,
    role: AGENT_ROLE,
    streamProjected: true,
    streaming: true,
  };
}

function completeActiveThoughtPart(message: Message): Message {
  const parts = message.parts;
  if (!parts) return message;
  const lastActiveIndex = parts.findLastIndex(
    (part) => part.type === "thought" && part.status === STREAMING_THOUGHT_STATUS,
  );
  if (lastActiveIndex === -1) return message;
  const updated = [...parts];
  const thought = updated[lastActiveIndex];
  if (thought?.type === "thought") {
    updated[lastActiveIndex] = {
      ...thought,
      status: COMPLETED_THOUGHT_STATUS,
    };
  }
  return { ...message, parts: updated };
}

function completeThoughtParts(message: Message): Message {
  const parts = message.parts;
  if (!parts) return message;
  return {
    ...message,
    parts: parts.map((part) =>
      part.type === "thought" && part.status === STREAMING_THOUGHT_STATUS
        ? { ...part, status: COMPLETED_THOUGHT_STATUS }
        : part,
    ),
  };
}

function transcriptText(message: Message): string {
  if (!message.parts) return message.content;
  return message.parts
    .filter((part): part is TextTranscriptPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}
