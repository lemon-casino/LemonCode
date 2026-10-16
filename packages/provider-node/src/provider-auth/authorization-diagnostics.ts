import {
  providerAuthorizationDiagnosticSchema,
  type ProviderAuthorizationDiagnostic,
} from "@lcode/shared";

/** 只输出固定字段；原始 cause 仅供分类，不能把 token、URL 或响应片段发给 UI/日志。 */
export function readAuthorizationDiagnostic(
  error: unknown,
  phase: ProviderAuthorizationDiagnostic["phase"],
  credentialsSaved = false,
): ProviderAuthorizationDiagnostic {
  let current = error;
  let code: ProviderAuthorizationDiagnostic["code"] =
    phase === "persisting" ? "storage" : "unknown";
  let status: number | undefined;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    const value = current as {
      diagnostic?: unknown;
      name?: string;
      code?: string;
      status?: number;
      cause?: unknown;
    };
    const diagnostic = providerAuthorizationDiagnosticSchema.safeParse(value.diagnostic);
    if (diagnostic.success) return { ...diagnostic.data, credentialsSaved };
    if (
      value.name === "TimeoutError" ||
      [
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(value.code ?? "")
    )
      code = "timeout";
    else if (value.name === "AbortError") code = "cancelled";
    else if (
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      ].includes(value.code ?? "") ||
      value.name === "TypeError"
    )
      code = "network";
    if (Number.isInteger(value.status) && value.status! >= 400 && value.status! <= 599) {
      status = value.status;
      code = "rejected";
    }
    current = value.cause;
  }
  return {
    phase,
    code,
    credentialsSaved,
    ...(status ? { status } : {}),
    retryable:
      ["timeout", "network", "storage"].includes(code) ||
      status === 429 ||
      (status !== undefined && status >= 500),
  };
}
