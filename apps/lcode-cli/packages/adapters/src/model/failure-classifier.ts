import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
} from "@lcode/contracts";
import {
  getErrorCode,
  getResponseHeaders,
  getStatusCode,
  isAbortFailure,
  isContextExceededFailure,
  isNetworkFailure,
  isProviderMarkedRetryable,
  isProxyFailure,
  isTimeoutFailure,
  parseRetryAfterMs,
  unwrapRetryError,
} from "./failure-inspection.js";
import { readMappedAiSdkProviderBusinessError } from "./failure-ai-sdk-provider-error.js";
import { isTlsFailure } from "./failure-tls.js";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.js";

import type { ClassifiedModelFailure } from "./failure-types.js";
import {
  classifyProviderBusinessFailure,
  classifyProviderBusinessFailureFromApiCallBody,
  findProviderBusinessError,
} from "./failure-provider-business.js";

export type { ClassifiedModelFailure } from "./failure-types.js";
export { findProviderBusinessError, inspectProviderFailure } from "./failure-provider-business.js";

export function classifyModelFailure(
  error: unknown,
  abortSignal?: AbortSignal,
): ClassifiedModelFailure {
  const unwrapped = unwrapRetryError(error);
  const statusCode = getStatusCode(unwrapped);
  const code = getErrorCode(unwrapped);
  const headers = getResponseHeaders(unwrapped);
  const retryAfterMs = parseRetryAfterMs(headers);

  if (code === ModelErrorCode.InvalidModelResponse) {
    return {
      code: ModelErrorCode.InvalidModelResponse,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model returned an invalid response.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (code === ModelErrorCode.InvalidModelRequest) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model request configuration is invalid.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isAbortFailure(unwrapped, abortSignal)) {
    return {
      code: ModelErrorCode.ModelRequestCancelled,
      message: "Model request was cancelled.",
      reason: ModelFailureReasonValue.Cancelled,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: unwrapped.message,
      reason: ModelFailureReasonValue.StreamIdleTimeout,
      retryReason: ModelRetryReasonValue.StreamIdleTimeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // fetch 层提前抛出的 ProviderBusinessError 不走 APICallError，
  // retry-after 必须在业务错误归一化时继续传下去。
  const providerBusinessFailure = classifyProviderBusinessFailure(
    findProviderBusinessError(unwrapped) ?? unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (providerBusinessFailure) {
    return providerBusinessFailure;
  }

  // AI SDK 的请求错误保留在 APICallError.data.error，流式 SSE 错误则直接提供
  // 已解析的 error 对象；这里统一消费这两种 AI SDK 输出，不新增 provider 原始响应旁路。
  const aiSdkErrorFailure = classifyProviderBusinessFailure(
    readMappedAiSdkProviderBusinessError(unwrapped),
    statusCode,
    retryAfterMs,
  );
  if (aiSdkErrorFailure) {
    return aiSdkErrorFailure;
  }

  // AI SDK 有时把 403 JSON（如 3007）包成 APICallError，不走 ProviderBusinessError；
  // 若在通用 403 鉴权分支之前不解析 responseBody，会误显示 “Provider authentication failed.”。
  const apiCallBodyFailure = classifyProviderBusinessFailureFromApiCallBody(
    unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (apiCallBodyFailure) {
    return apiCallBodyFailure;
  }

  if (isTimeoutFailure(unwrapped, code, statusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: "Model request timed out.",
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 429) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message: "Provider rate limited the model request.",
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 529) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider is overloaded.",
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message: "Provider authentication failed.",
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode === 400 || statusCode === 422) {
    const contextExceeded = isContextExceededFailure(unwrapped);
    return {
      code: contextExceeded
        ? ModelErrorCode.ModelContextExceeded
        : ModelErrorCode.InvalidModelRequest,
      message: contextExceeded
        ? "Model request exceeded the provider context window."
        : "Provider rejected the model request.",
      reason: contextExceeded
        ? ModelFailureReasonValue.ContextExceeded
        : ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isContextExceededFailure(unwrapped)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider returned a server error.",
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isTlsFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "TLS validation failed for the provider request.",
      reason: ModelFailureReasonValue.TlsError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isProxyFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Proxy connection failed for the provider request.",
      reason: ModelFailureReasonValue.ProxyError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isNetworkFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  const retryable = isProviderMarkedRetryable(unwrapped);
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: retryable
      ? "Provider marked the model request as retryable."
      : "Model request failed.",
    reason: retryable ? ModelFailureReasonValue.ServerError : ModelFailureReasonValue.Unknown,
    retryReason: retryable ? ModelRetryReasonValue.ServerError : ModelRetryReasonValue.NetworkError,
    retryable,
    retryAfterMs,
    statusCode,
  };
}

export function isRetryableFailure(failure: ClassifiedModelFailure): boolean {
  return failure.retryable && failure.reason !== ModelFailureReasonValue.Cancelled;
}
