import type { ModelRetryBudget } from "@lcode/contracts";
import type { ApiKeyBoundAttempt } from "./model-execution.js";
import { retryBudgetAllows } from "./retry-budget.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";

/** 401/403 或明确 Key 级 429 才能切换；每次必须重新经过 Runner 的预算和准入。 */
export function canRotateApiKey(input: {
  apiKeyAttempt?: ApiKeyBoundAttempt;
  error: unknown;
  signal?: AbortSignal;
  outputCommitted?: boolean;
  retryBudget?: ModelRetryBudget;
  attempt: number;
  maxAttempts: number;
}): boolean {
  return Boolean(
    input.apiKeyAttempt?.canRotate &&
    !input.signal?.aborted &&
    !input.outputCommitted &&
    !(input.error instanceof RuntimeHeadersRefreshError) &&
    retryBudgetAllows(input.retryBudget, input.attempt, input.maxAttempts),
  );
}
