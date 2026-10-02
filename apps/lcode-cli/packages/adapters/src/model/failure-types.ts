import type {
  ModelErrorCode as ModelErrorCodeType,
  ModelFailureReason,
  ModelRetryReason,
} from "@lcode/contracts";

export interface ClassifiedModelFailure {
  code: ModelErrorCodeType;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}
