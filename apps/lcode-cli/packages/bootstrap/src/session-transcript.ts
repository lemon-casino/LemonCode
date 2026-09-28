import {
  parseCompletedToolPartMetadata,
  parseToolResultDisplayPayload,
  type MessagePart,
  type MessageWithParts,
  type SessionId,
  type SessionStorePort,
  type ToolResultDisplayPayload,
} from "@lcode/contracts";
import { getConversationMessageProjectionPolicy } from "@lcode/shared";

export type SessionTranscriptPart =
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "thought";
    }
  | {
      error?: string;
      input: Record<string, unknown>;
      output?: string;
      resultDisplay?: ToolResultDisplayPayload;
      status: "pending" | "running" | "completed" | "failed";
      title?: string;
      toolCallId: string;
      toolName: string;
      type: "tool";
    };

export interface SessionTranscriptMessage {
  content: string;
  parts?: SessionTranscriptPart[];
  role: "agent" | "user";
}

export async function loadSessionTranscriptFromStore(input: {
  sessionId: SessionId;
  sessionStore?: SessionStorePort;
}): Promise<SessionTranscriptMessage[]> {
  if (!input.sessionStore) {
    return [];
  }

  const messages = await input.sessionStore.messages({
    sessionID: input.sessionId,
  });
  return projectSessionTranscript(messages);
}

export function projectSessionTranscript(
  messages: readonly MessageWithParts[],
): SessionTranscriptMessage[] {
  const transcript: SessionTranscriptMessage[] = [];

  for (const message of messages) {
    if (isSummaryMessage(message)) {
      continue;
    }
    if (isModelOnlyUserMessage(message)) {
      // goal continuation 等 runtime 内部输入需要保留在 raw history 供模型恢复，
      // 但 transcript 是用户可见投影，不能把这类 user-role 输入展示成用户发言。
      continue;
    }

    const parts = dedupeMessageParts(message.parts);

    if (message.info.role === "user") {
      const text = userReplayTextFromParts(parts);
      if (text.trim().length === 0) {
        continue;
      }
      transcript.push({
        content: text,
        role: "user",
      });
      continue;
    }

    const transcriptParts = assistantReplayPartsFromParts(parts);
    const hasStructuredParts = transcriptParts.some((part) => part.type !== "text");
    const visibleParts = hasStructuredParts ? transcriptParts : [];
    const text = transcriptParts
      .filter(
        (part): part is Extract<SessionTranscriptPart, { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n\n");
    if (text.trim().length === 0 && visibleParts.length === 0) {
      continue;
    }
    transcript.push({
      content: text,
      ...(visibleParts.length > 0 ? { parts: visibleParts } : {}),
      role: "agent",
    });
  }

  return transcript;
}

function isSummaryMessage(message: MessageWithParts): boolean {
  return message.info.role === "user"
    ? message.info.summary !== undefined
    : message.info.summary === true;
}

function isModelOnlyUserMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return false;
  }
  return getConversationMessageProjectionPolicy(message) !== "realUserInput";
}

function dedupeMessageParts(parts: readonly MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();

  for (const part of parts) {
    byId.set(part.id, part);
  }

  return [...byId.values()];
}

function userReplayTextFromParts(parts: readonly MessagePart[]): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      chunks.push(part.text);
      continue;
    }

    if (part.type === "file") {
      chunks.push(`[Attached file: ${part.filename ?? part.url}]`);
      continue;
    }

    if (part.type === "agent") {
      chunks.push(`[Selected agent: ${part.name}]`);
    }
  }

  return chunks.join("\n\n");
}

function assistantReplayPartsFromParts(parts: readonly MessagePart[]): SessionTranscriptPart[] {
  const transcriptParts: SessionTranscriptPart[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      transcriptParts.push({ text: part.text, type: "text" });
      continue;
    }

    if (part.type === "reasoning") {
      transcriptParts.push({ text: part.text, type: "thought" });
      continue;
    }

    if (part.type === "tool") {
      transcriptParts.push(toolReplayPartFromPart(part));
    }
  }

  return transcriptParts;
}

function toolReplayPartFromPart(
  part: Extract<MessagePart, { type: "tool" }>,
): SessionTranscriptPart {
  const base = {
    input: part.state.input,
    toolCallId: part.callID,
    toolName: part.tool,
    type: "tool" as const,
  };

  if (part.state.status === "completed") {
    const resultDisplay = replayToolResultDisplay(part.state.metadata);
    return {
      ...base,
      output: part.state.output,
      ...(resultDisplay ? { resultDisplay } : {}),
      status: "completed",
      title: part.state.title,
    };
  }

  if (part.state.status === "error") {
    return {
      ...base,
      error: part.state.error,
      status: "failed",
    };
  }

  return {
    ...base,
    status: part.state.status,
    ...("title" in part.state && part.state.title ? { title: part.state.title } : {}),
  };
}

function replayToolResultDisplay(
  metadata: Record<string, unknown> | undefined,
): ToolResultDisplayPayload | undefined {
  const parsed = parseCompletedToolPartMetadata(metadata);
  if (parsed?.display) {
    return parsed.display;
  }

  return parseToolResultDisplayPayload(metadata?.display);
}
