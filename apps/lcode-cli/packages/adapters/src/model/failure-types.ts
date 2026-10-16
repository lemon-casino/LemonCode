import type {
  ModelErrorCode as ModelErrorCodeType,
  ModelFailureReason,
  ModelRetryReason,
} from "@lcode/contracts";

export interface ClassifiedModelFailure {
  routing?: import("@lcode/shared").RoutingFailureInfo;
  code: ModelErrorCodeType;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}
