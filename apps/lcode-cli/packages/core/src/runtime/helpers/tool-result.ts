import { modelMessageContentToText } from "../deps.js";
import { isBashOutputProviderError } from "../../tool/handlers/bash-model-content.js";
import type { ModelMessageContent, ToolCallId, ToolSchedule, ToolExecutionResult } from "../deps.js";

export function emptyTokenUsageInfo(): ReturnType<typeof toTokenUsageInfo> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

export function toTokenUsageInfo(usage?: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
} {
  return {
    total: usage?.totalTokens,
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
    cache: {
      read: usage?.cacheReadTokens ?? 0,
      write: usage?.cacheWriteTokens ?? 0,
    },
  };
}

export function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

export function stringifyToolResultOutput(result: ToolExecutionResult): string {
  if (result.modelContent !== undefined) {
    return typeof result.modelContent === "string"
      ? result.modelContent
      : modelMessageContentToText(result.modelContent);
  }
  if (!result.success && result.error?.message) return result.error.message;
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined) return "";
  return JSON.stringify(result.output) ?? "";
}

export function modelContentForToolResult(result: ToolExecutionResult): ModelMessageContent {
  if (result.modelContent !== undefined) return result.modelContent;
  return stringifyToolResultOutput(result);
}

export function isErrorForToolResult(result: ToolExecutionResult): boolean {
  if (!result.success) return true;
  if (!isRecord(result.output)) return false;

  const explicitIsError = result.output.isError ?? result.output.is_error;
  if (typeof explicitIsError === "boolean") return explicitIsError;

  if (result.toolName === "Bash" && typeof result.output.interrupted === "boolean") {

    if (isBashOutputProviderError(result.output)) return true;
    return result.output.interrupted;
  }

  return false;
}

export function stringifyForEstimation(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpToolName(
  name: string,
): { serverName: string; toolName: string } | undefined {
  if (!name.startsWith("mcp__")) {
    return undefined;
  }
  const [, serverName, ...toolParts] = name.split("__");
  if (!serverName || toolParts.length === 0) {
    return undefined;
  }
  return {
    serverName,
    toolName: toolParts.join("__"),
  };
}

export function findParallelGroupIndex(schedule: ToolSchedule, toolCallId: ToolCallId): number {
  return schedule.parallelGroups.findIndex((group) => group.includes(toolCallId));
}
