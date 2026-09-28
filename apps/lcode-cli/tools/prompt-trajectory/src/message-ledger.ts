import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject, OpenAiMessage, TrajectoryJsonlEntry } from "./types.js";

export class MessageLedger {
  private constructor(
    private readonly file: FileHandle,
    private requestIndex: number,
  ) {}

  static async open(path: string): Promise<MessageLedger> {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "w");
    return new MessageLedger(file, 0);
  }

  async close(): Promise<void> {
    await this.file.close();
  }

  async recordRequestBody(body: JsonObject): Promise<number> {
    const messages = requestMessagesFromBody(body);
    if (!messages) {
      throw new Error("OpenAI request body must contain a messages or input array.");
    }

    this.requestIndex += 1;
    const requestIndex = this.requestIndex;
    const { input: _input, messages: _messages, ...bodyWithoutMessages } = body;
    await this.write({
      kind: "request",
      requestIndex,
      bodyWithoutMessages,
    });

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!isOpenAiMessage(message)) {
        throw new Error(`OpenAI request message ${messageIndex} is missing role.`);
      }
      await this.write({
        kind: "message",
        message,
        messageIndex,
        requestIndex,
      });
    }

    return requestIndex;
  }

  async recordAssistantMessage(requestIndex: number, message: OpenAiMessage | null): Promise<void> {
    if (!message) return;
    await this.write({
      kind: "message",
      message,
      requestIndex,
    });
  }

  private async write(entry: TrajectoryJsonlEntry): Promise<void> {
    await this.file.write(`${JSON.stringify(entry)}\n`);
  }
}

function requestMessagesFromBody(body: JsonObject): unknown[] | undefined {
  if (Array.isArray(body.messages)) return body.messages;
  if (!Array.isArray(body.input)) return undefined;

  return body.input.flatMap((item) => responseInputItemToMessage(item));
}

function responseInputItemToMessage(item: unknown): OpenAiMessage[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const record = item as Record<string, unknown>;
  if (typeof record.role === "string") {
    return [JSON.parse(JSON.stringify(record)) as OpenAiMessage];
  }
  if (record.type === "function_call") {
    return [
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            id: typeof record.call_id === "string" ? record.call_id : undefined,
            type: "function",
            function: {
              arguments: typeof record.arguments === "string" ? record.arguments : "",
              name: typeof record.name === "string" ? record.name : "",
            },
          },
        ],
      },
    ];
  }
  if (record.type === "function_call_output") {
    return [
      {
        content: typeof record.output === "string" ? record.output : JSON.stringify(record.output),
        role: "tool",
        tool_call_id: typeof record.call_id === "string" ? record.call_id : undefined,
      },
    ];
  }
  return [];
}

function isOpenAiMessage(value: unknown): value is OpenAiMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { role?: unknown }).role === "string",
  );
}
