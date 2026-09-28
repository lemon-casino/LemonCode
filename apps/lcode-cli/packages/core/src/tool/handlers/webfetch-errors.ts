import { CoreErrorType, createCoreError } from "@lcode/contracts";
import { WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";

type WebFetchErrorCode = keyof typeof WEBFETCH_ERROR_CODE_MAP;

export function webFetchError(
  code: WebFetchErrorCode,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    cause: cause instanceof Error ? cause : undefined,
    context: {
      ...context,
      webFetchCode: WEBFETCH_ERROR_CODE_MAP[code],
      toolName: WEBFETCH_TOOL_NAME,
    },
    recoverable: true,
    retryable: code === "FetchFailed" || code === "ProcessingFailed",
  });
}

const WEBFETCH_ERROR_CODE_MAP = {
  InvalidUrl: "webfetch_invalid_url",
  UnsupportedProtocol: "webfetch_unsupported_protocol",
  CredentialsInUrl: "webfetch_credentials_in_url",
  MissingRedirectLocation: "webfetch_missing_redirect_location",
  UnsafeRedirect: "webfetch_unsafe_redirect",
  EgressBlocked: "webfetch_egress_blocked",
  TooManyRedirects: "webfetch_too_many_redirects",
  ResponseTooLarge: "webfetch_response_too_large",
  FetchFailed: "webfetch_fetch_failed",
  ProcessingFailed: "webfetch_processing_failed",
} as const;
