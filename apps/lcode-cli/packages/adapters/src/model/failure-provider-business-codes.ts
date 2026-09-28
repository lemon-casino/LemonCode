import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@lcode/contracts";
import { isNetworkFailure, isTimeoutFailure } from "./failure-inspection.js";
import type { ProviderBusinessError } from "./model-execution.js";

interface ProviderBusinessCodeMapping {
  code: ModelErrorCodeType;
  message?: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
}

// 部分 OpenAI-compatible provider 会把可恢复的上游网络故障包装成业务码。
const PROVIDER_NETWORK_BUSINESS_CODES = new Set(["1234"]);
const PROVIDER_INTERNAL_NETWORK_MESSAGES = new Set([
  "500 internal network error",
  "internal network error",
  "internal network failure",
]);

const TERMINAL_RATE_LIMIT_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRateLimited,
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: false,
};
const TERMINAL_BUSINESS_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRequestFailed,
  reason: ModelFailureReasonValue.Unknown,
  retryReason: ModelRetryReasonValue.NetworkError,
  retryable: false,
};
const RETRYABLE_RATE_LIMIT_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRateLimited,
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: true,
};
const RETRYABLE_OVERLOAD_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRequestFailed,
  reason: ModelFailureReasonValue.ProviderOverloaded,
  retryReason: ModelRetryReasonValue.ProviderOverloaded,
  retryable: true,
};

const PROVIDER_BUSINESS_CODE_MAPPINGS = new Map<string, ProviderBusinessCodeMapping>([
  [
    "500",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1006",
    {
      code: ModelErrorCode.ProviderNotConfigured,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
    },
  ],
  [
    "1005",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3006",
    {
      code: ModelErrorCode.ModelNotFound,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3001",
    {
      code: ModelErrorCode.InvalidModelRequest,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3007",
    {
      code: ModelErrorCode.InvalidModelRequest,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
    },
  ],
  // 3008/3009/3010：并发上限，与配额耗尽 1005 类似但不走 refresh-quota，而是走升级横幅。
  [
    "3008",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "3009",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  // 3010：当前模型并发上限。保留为非自动重试的 rate limited，由 UI 引导切换模型或升级。
  [
    "3010",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  // BigModel 文档里的恢复类错误需要显式入表；同时把 1261 标成超窗，
  // 长期配额、套餐权限、公平使用限制和 provider 明确终止型业务码则显式终止，避免 generic 429 兜底误重试。
  [
    "1120",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1230",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1234",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
    },
  ],
  [
    "1261",
    {
      code: ModelErrorCode.ModelContextExceeded,
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1113",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1302",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1303",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1305",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1304",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1308",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1309",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1310",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1311",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1312",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
    },
  ],
  [
    "1313",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "3002",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "2007",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
]);

// 这些 code 均来自 provider 官方文档，且语义需要用户充值、调整套餐或等待长期额度重置。
// 只消费 AI SDK / 既有 ProviderBusinessError 已暴露的 code，不在这里解析厂商原始 response 字段。
// insufficient_quota 曾落入通用 429 重试；其终止语义不能再依赖 Retry-After 时长。
for (const code of [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
  "2056",
  "20097",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, TERMINAL_RATE_LIMIT_MAPPING);
}

for (const code of ["1008", "1314", "1315"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, TERMINAL_BUSINESS_MAPPING);
}

for (const code of ["rate_limit_reached_error", "rate_limit_error"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, RETRYABLE_RATE_LIMIT_MAPPING);
}

for (const code of ["engine_overloaded_error", "overloaded_error"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, RETRYABLE_OVERLOAD_MAPPING);
}

export function getProviderBusinessCodeMapping(
  providerCode: string,
): ProviderBusinessCodeMapping | undefined {
  return PROVIDER_BUSINESS_CODE_MAPPINGS.get(providerCode);
}

export function isRetryableProviderBusinessNetworkFailure(
  error: ProviderBusinessError,
  providerCode: string | undefined,
): boolean {
  if (providerCode) {
    // AI SDK 的 SSE error chunk 会把底层 ECONNRESET 包进 ProviderBusinessError.providerCode。
    // 这本质仍是传输层断连，必须沿用网络错误重试语义，而不是落成 unknown。
    if (isNetworkFailure(providerCode)) {
      return true;
    }
    if (PROVIDER_NETWORK_BUSINESS_CODES.has(providerCode)) {
      return true;
    }

    const normalizedCode = providerCode.toLowerCase();
    if (normalizedCode === "network_error" || normalizedCode === "network_error_retryable") {
      return true;
    }
  }

  return isProviderBusinessInternalNetworkFailure(error);
}

export function isRetryableProviderBusinessTimeoutFailure(
  error: ProviderBusinessError,
  providerCode: string | undefined,
  statusCode?: number,
): boolean {
  // AI SDK/SSE error chunk 可能把底层 headers/body timeout 包进 ProviderBusinessError.providerCode。
  // 这类错误没有真正的 provider 业务语义，必须保留普通 timeout 的可重试语义。
  return isTimeoutFailure(
    error,
    providerCode,
    statusCode ?? error.statusCode ?? error.responseStatus,
  );
}

function isProviderBusinessInternalNetworkFailure(error: ProviderBusinessError): boolean {
  if (readResponseBodyErrorType(error.responseBodySummary) !== "api_error") {
    return false;
  }

  const normalizedMessage =
    normalizeProviderMessage(error.providerMessage) ??
    normalizeProviderMessage(error.message) ??
    normalizeProviderMessage(readResponseBodyErrorMessage(error.responseBodySummary));
  return normalizedMessage ? PROVIDER_INTERNAL_NETWORK_MESSAGES.has(normalizedMessage) : false;
}

function readResponseBodyErrorType(summary: unknown): string | undefined {
  return normalizeProviderMessage(asRecord(asRecord(summary).error).type);
}

function readResponseBodyErrorMessage(summary: unknown): string | undefined {
  return stringValue(asRecord(asRecord(summary).error).message);
}

function normalizeProviderMessage(value: unknown): string | undefined {
  const text = stringValue(value)?.trim().toLowerCase();
  return text && text.length > 0 ? text : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
