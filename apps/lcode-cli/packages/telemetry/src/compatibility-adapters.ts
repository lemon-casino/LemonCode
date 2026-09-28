import type { Attributes } from "@opentelemetry/api";
import type { ResolvedModelTelemetryDescriptor } from "@lcode/contracts/telemetry";
import {
  compactAttributes,
  integer,
  safeEnum,
  safeId,
  safeIdentifier,
  safeString,
} from "./agent-trace-support.js";

/**
 * 外部语义约定只在这里投影。`lcode.*` 始终是内部查询的权威字段；
 * GenAI、标准 HTTP/Server 字段只用于兼容外部分析工具，避免标准漂移侵入 Writer API。
 */
export function toolCompatibilityAttributes(input: {
  toolCallId: string;
  toolName: string;
}): Attributes {
  return compactAttributes({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": safeId(input.toolCallId),
    "gen_ai.tool.name": safeString(input.toolName, 128),
  });
}

export function commandCompatibilityAttributes(input: {
  exitCode?: number;
  signal?: string;
}): Attributes {
  return compactAttributes({
    "process.exit.code": integer(input.exitCode),
    "process.signal.name": safeIdentifier(input.signal),
  });
}

export function modelAttemptCompatibilityAttributes(
  target: ResolvedModelTelemetryDescriptor,
): Attributes {
  return compactAttributes({
    "gen_ai.provider.name": safeEnum(target.providerKind),
    "gen_ai.request.model": safeString(target.requestedModel, 128),
    "server.address": serverAddress(target.providerOrigin),
    "server.port": serverPort(target.providerOrigin),
  });
}

export function modelResponseCompatibilityAttributes(input: {
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  responseModel?: string;
}): Attributes {
  return compactAttributes({
    "gen_ai.response.finish_reasons": input.finishReason
      ? [safeString(input.finishReason, 128)]
      : undefined,
    "gen_ai.response.model": safeString(input.responseModel, 128),
    "gen_ai.usage.input_tokens": integer(input.inputTokens),
    "gen_ai.usage.output_tokens": integer(input.outputTokens),
  });
}

export function httpResponseCompatibilityAttributes(statusCode: number): Attributes {
  return compactAttributes({
    "http.response.status_code": integer(statusCode),
  });
}

function serverAddress(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return safeString(new URL(origin).hostname);
  } catch {
    return undefined;
  }
}

function serverPort(origin: string | undefined): number | undefined {
  if (!origin) return undefined;
  try {
    const parsed = new URL(origin);
    if (parsed.port) return integer(Number(parsed.port));
    return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : undefined;
  } catch {
    return undefined;
  }
}
