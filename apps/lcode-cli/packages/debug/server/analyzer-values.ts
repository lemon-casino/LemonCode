import { isRecord, numberValue, stringValue } from "./sources.js";

export function extractUsage(payload?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const usage = isRecord(payload?.usage) ? payload.usage : payload;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  return {
    inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total) ?? 0,
    cacheReadTokens:
      numberValue(usage.cacheReadTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.read : undefined) ??
      0,
    cacheWriteTokens:
      numberValue(usage.cacheWriteTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.write : undefined) ??
      0,
  };
}

export function textFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return (
    textFromContent(payload.content) ??
    textFromContent(payload.text) ??
    textFromContent(payload.message)
  );
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return textFromContent(part.text) ?? textFromContent(part.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (isRecord(content)) {
    return textFromContent(content.text) ?? textFromContent(content.content);
  }
  return undefined;
}

export function eventToolCallId(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolCallId);
}

export function eventToolName(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolName) ?? stringValue(payload?.name);
}

export function modelName(payload?: Record<string, unknown>): string | undefined {
  const modelSelection = isRecord(payload?.modelSelection) ? payload.modelSelection : undefined;
  return stringValue(modelSelection?.modelId) ?? stringValue(payload?.model);
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function preview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

export function estimateTokens(text: string): number {
  const chineseChars = text.match(/[一-鿿]/g)?.length ?? 0;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / 3);
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export function compareIsoAsc(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

export function compareIsoDesc(left?: string, right?: string): number {
  return compareIsoAsc(right, left);
}
