import type { OpenAiMessage } from "./types.js";

interface ToolCallAccumulator {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
  type?: string;
}

export function assembleNonStreamingAssistantMessage(body: unknown): OpenAiMessage | null {
  const message = firstChoiceMessage(body);
  if (!message) return responseOutputMessage(body);
  return ensureAssistantRole(message);
}

export function assembleStreamingAssistantMessage(chunks: readonly (string | Uint8Array)[]): OpenAiMessage | null {
  const text = chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)))
    .join("");
  let role = "assistant";
  let content = "";
  let reasoningContent = "";
  const toolCalls = new Map<number, ToolCallAccumulator>();

  for (const payload of parseSseDataPayloads(text)) {
    if (payload === "[DONE]") continue;
    const parsed = parseJson(payload);
    if (!parsed) continue;
    const delta = firstChoiceDelta(parsed);
    if (!delta) continue;

    if (typeof delta.role === "string") {
      role = delta.role;
    }
    if (typeof delta.content === "string") {
      content += delta.content;
    }
    if (typeof delta.reasoning_content === "string") {
      reasoningContent += delta.reasoning_content;
    }
    mergeToolCallDeltas(toolCalls, delta.tool_calls);
  }

  const message: OpenAiMessage = { role };
  if (content.length > 0 || toolCalls.size > 0) {
    message.content = content;
  }
  if (reasoningContent.length > 0) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => normalizeToolCall(toolCall));
  }

  return Object.keys(message).length > 1 || role === "assistant" ? message : null;
}

function firstChoiceMessage(body: unknown): OpenAiMessage | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  return message as OpenAiMessage;
}

function responseOutputMessage(body: unknown): OpenAiMessage | null {
  if (!body || typeof body !== "object") return null;
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  const functionCall = output.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as { type?: unknown }).type === "function_call",
  ) as Record<string, unknown> | undefined;
  if (functionCall) {
    return {
      content: "",
      role: "assistant",
      tool_calls: [
        {
          id: typeof functionCall.call_id === "string" ? functionCall.call_id : undefined,
          type: "function",
          function: {
            arguments:
              typeof functionCall.arguments === "string" ? functionCall.arguments : "",
            name: typeof functionCall.name === "string" ? functionCall.name : "",
          },
        },
      ],
    };
  }

  const message = output.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as { type?: unknown }).type === "message",
  ) as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = Array.isArray(message.content)
    ? message.content
        .map((item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as { text?: unknown }).text === "string"
            ? ((item as { text: string }).text)
            : "",
        )
        .join("")
    : "";
  return {
    content,
    role: "assistant",
  };
}

function ensureAssistantRole(message: OpenAiMessage): OpenAiMessage {
  return {
    ...JSON.parse(JSON.stringify(message)),
    role: typeof message.role === "string" ? message.role : "assistant",
  };
}

function firstChoiceDelta(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const delta = (first as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return null;
  return delta as Record<string, unknown>;
}

function parseSseDataPayloads(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload.length > 0);
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function mergeToolCallDeltas(
  toolCalls: Map<number, ToolCallAccumulator>,
  deltas: unknown,
): void {
  if (!Array.isArray(deltas)) return;

  for (const delta of deltas) {
    if (!delta || typeof delta !== "object") continue;
    const record = delta as {
      function?: {
        arguments?: unknown;
        name?: unknown;
      };
      id?: unknown;
      index?: unknown;
      type?: unknown;
    };
    const index = typeof record.index === "number" ? record.index : toolCalls.size;
    const current = toolCalls.get(index) ?? {};
    if (typeof record.id === "string") {
      current.id = record.id;
    }
    if (typeof record.type === "string") {
      current.type = record.type;
    }
    if (record.function && typeof record.function === "object") {
      current.function = current.function ?? {};
      if (typeof record.function.name === "string") {
        current.function.name = `${current.function.name ?? ""}${record.function.name}`;
      }
      if (typeof record.function.arguments === "string") {
        current.function.arguments = `${current.function.arguments ?? ""}${record.function.arguments}`;
      }
    }
    toolCalls.set(index, current);
  }
}

function normalizeToolCall(toolCall: ToolCallAccumulator): Record<string, unknown> {
  return {
    ...(toolCall.id ? { id: toolCall.id } : {}),
    type: toolCall.type ?? "function",
    function: {
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "",
    },
  };
}
