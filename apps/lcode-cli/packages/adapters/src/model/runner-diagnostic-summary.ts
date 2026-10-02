import type { ModelUsage } from "@lcode/contracts";
import { asRecord, stringProperty } from "./runner-record.js";

export function summarizeProviderBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (body === null) return { type: "null" };

  if (typeof body === "string") {
    return {
      length: body.length,
      preview: body.slice(0, 500),
      type: "string",
    };
  }

  if (typeof body !== "object") {
    return {
      type: typeof body,
      value: summarizeScalar(body),
    };
  }

  const record = body as Record<string, unknown>;
  return {
    code: summarizeScalar(record.code),
    error: summarizeProviderError(record.error),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    msg: summarizeScalar(record.msg),
    status: summarizeScalar(record.status),
    success: typeof record.success === "boolean" ? record.success : undefined,
    type: Array.isArray(body) ? "array" : "object",
  };
}

function summarizeProviderError(error: unknown): unknown {
  if (error === undefined || error === null || typeof error !== "object") {
    return summarizeScalar(error);
  }

  const record = error as Record<string, unknown>;
  return {
    code: summarizeScalar(record.code),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    type: summarizeScalar(record.type),
  };
}

export function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  return {
    chunkKeys: objectKeys(record),
    chunkType: stringProperty(record, "type") ?? typeof chunk,
    finishReason: summarizeScalar(record.finishReason),
    rawFinishReason: summarizeScalar(record.rawFinishReason),
  };
}

export function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

export function summarizeScalar(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
}

export function objectKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value).slice(0, 20);
}
