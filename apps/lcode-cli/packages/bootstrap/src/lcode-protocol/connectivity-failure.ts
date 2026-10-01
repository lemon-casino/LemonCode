import { isProviderBusinessError } from "@lcode/adapters/model";
import { CoreErrorType, ModelErrorCode, ModelProtocolError, isCoreError } from "@lcode/contracts";
import type { ModelConnectivityResult } from "@lcode/shared";

const MODEL_REJECTION_CODES = new Set(["model_not_found", "invalid_model"]);
const MODEL_REJECTION_HTTP_STATUSES = new Set([400, 404, 422]);
const NON_MODEL_FAILURE_CODES = new Set<string>([
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelRequestAuthMissing,
  ModelErrorCode.ModelRequestCancelled,
  ModelErrorCode.ModelRequestTimeout,
  ModelErrorCode.ModelRateLimited,
]);
const MAX_CAUSE_DEPTH = 16;
const MAX_RESPONSE_BODY_CHARS = 64_000;
// AI SDK 使用 Symbol.for 标记跨副本错误；只检查 name 会把本地同名异常误作供应商证据。
const AI_SDK_API_CALL_ERROR = Symbol.for("vercel.ai.error.AI_APICallError");

export function classifyModelConnectivityFailure(
  error: unknown,
  abortSignal?: AbortSignal,
): Extract<ModelConnectivityResult, { success: false }> {
  const confirmed = !abortSignal?.aborted && hasConfirmedModelRejection(error);
  return {
    success: false,
    error: {
      message:
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Model connectivity test failed.",
      ...(confirmed ? { code: "model-not-found" as const } : {}),
    },
  };
}

function hasConfirmedModelRejection(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  let confirmed = false;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const record = asRecord(current);
    if (!record) return confirmed;
    if (seen.has(record)) return false;
    seen.add(record);
    const context = asRecord(record.context);
    if (
      current instanceof ModelProtocolError ||
      (isCoreError(current) && current.type !== CoreErrorType.ModelError) ||
      record.name === "AbortError" ||
      record.name === "TimeoutError" ||
      (typeof record.code === "string" && NON_MODEL_FAILURE_CODES.has(record.code)) ||
      context?.source === "runtime" ||
      context?.source === "network"
    )
      return false;

    // 现有 ModelNotFound 同时表示本地 Registry 缺失和任意 HTTP404，不能当删除依据。
    // 必须保留真实 HTTP 状态与上游精确业务码；鉴权/限流/服务故障即使夹带该码也不删除。
    if (isProviderBusinessError(current)) {
      if (!MODEL_REJECTION_HTTP_STATUSES.has(current.responseStatus ?? 0)) return false;
      confirmed ||=
        (current.providerKind === "openai" || current.providerKind === "openai-compatible") &&
        typeof current.providerCode === "string" &&
        MODEL_REJECTION_CODES.has(current.providerCode);
    } else if (Reflect.get(record, AI_SDK_API_CALL_ERROR) === true) {
      if (
        typeof record.statusCode !== "number" ||
        !MODEL_REJECTION_HTTP_STATUSES.has(record.statusCode)
      )
        return false;
      const payload = asRecord(record.data) ?? parseResponseBody(record.responseBody);
      const code = asRecord(payload?.error)?.code;
      confirmed ||= typeof code === "string" && MODEL_REJECTION_CODES.has(code);
    }
    current = record.cause;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseResponseBody(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length > MAX_RESPONSE_BODY_CHARS) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}
