import { getApiCallErrorData, getResponseHeaders, getStatusCode } from "./failure-inspection.js";
import { getProviderBusinessCodeMapping } from "./failure-provider-business-codes.js";
import { ProviderBusinessError } from "./model-execution.js";

const MAX_SAFE_PROVIDER_FIELD_CHARS = 1_000;

/**
 * 只读取 AI SDK 已解析并暴露的错误对象；未知业务码继续交给既有通用分类链路。
 */
export function readMappedAiSdkProviderBusinessError(
  error: unknown,
): ProviderBusinessError | undefined {
  const data = asRecord(getApiCallErrorData(error));
  const errorData = asRecord(data?.error) ?? asRecord(error);
  if (!errorData) return undefined;

  // OpenAI-compatible schema 的 code 比 type 更具体；例如 type 可能统一为
  // insufficient_quota，而 code 才区分余额或组织/项目消费上限。
  const providerCode = [
    normalizeProviderCode(errorData.code),
    normalizeProviderCode(errorData.type),
  ].find(
    (candidate) =>
      candidate !== undefined && getProviderBusinessCodeMapping(candidate) !== undefined,
  );
  if (!providerCode) return undefined;

  const statusCode = getStatusCode(error);
  return new ProviderBusinessError({
    providerCode,
    providerId: "unknown",
    providerKind: "openai-compatible",
    providerMessage: stringValue(errorData.message),
    providerRequestId: readProviderRequestId(data, errorData),
    responseBodySummary: summarizeAiSdkErrorData(data, errorData),
    responseHeaders: getResponseHeaders(error),
    responseStatus: statusCode,
    statusCode,
  });
}

function readProviderRequestId(
  data: Record<string, unknown> | undefined,
  errorData: Record<string, unknown>,
): string | undefined {
  for (const record of [data, errorData]) {
    if (!record) continue;
    for (const key of ["request_id", "requestId", "id"] as const) {
      const value = stringValue(record[key]);
      if (value) return value.slice(0, MAX_SAFE_PROVIDER_FIELD_CHARS);
    }
  }
  return undefined;
}

function summarizeAiSdkErrorData(
  data: Record<string, unknown> | undefined,
  errorData: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (data) {
    copyScalar(data, summary, "request_id");
    copyScalar(data, summary, "requestId");
  }

  const errorSummary: Record<string, unknown> = {};
  // message 已由 ProviderBusinessError 统一清理和截断；摘要只保留分类字段。
  copyScalar(errorData, errorSummary, "code");
  copyScalar(errorData, errorSummary, "type");
  copyScalar(errorData, errorSummary, "request_id");
  copyScalar(errorData, errorSummary, "requestId");
  summary.error = errorSummary;
  return summary;
}

function copyScalar(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    target[key] = value;
  }
}

function normalizeProviderCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
