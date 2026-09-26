import type { Logger, ModelRetryYieldDecision } from "@zcode/contracts";
import type { AiSdkModelAdapterError } from "./errors.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export interface DeferredRetryYieldGate {
  adapterError: AiSdkModelAdapterError;
  failure: ClassifiedModelFailure;
  shouldYield: () => Promise<boolean>;
}

export class RetryYieldBeforeInvocationError extends Error {
  readonly adapterError: AiSdkModelAdapterError;

  constructor(adapterError: AiSdkModelAdapterError) {
    super("Model retry yielded to execution failover before provider invocation.");
    this.name = "RetryYieldBeforeInvocationError";
    this.adapterError = adapterError;
  }
}

export function createDeferredRetryYieldGate(
  input: Parameters<typeof shouldYieldRetryToFailover>[0],
  adapterError: AiSdkModelAdapterError,
): DeferredRetryYieldGate {
  return {
    adapterError,
    failure: input.failure,
    shouldYield: async () => {
      const decision = await shouldYieldRetryToFailover(input);
      if (decision.shouldYield) {
        adapterError.enrichContext({
          ...adapterError.context,
          ...retryYieldDecisionContext(decision, input.consumedRetryAttempts),
        });
      }
      return decision.shouldYield;
    },
  };
}

export async function shouldYieldRetryToFailover(input: {
  attempt: number;
  canRetry: boolean;
  consumedRetryAttempts: number;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
}): Promise<ModelRetryYieldDecision> {
  if (!input.canRetry) return noRetryYield();
  const gate = input.request.shouldYieldRetryToFailover;
  if (!gate) return noRetryYield();

  try {
    const decision = await gate({
      attempt: input.attempt,
      errorCode: input.failure.code,
      modelId: String(input.resolved.modelId),
      providerId: String(input.resolved.providerId),
      // 空 completion 的终态分类是 unknown，但它的物理重试原因是 server_error。
      // retry-yield 必须使用可接管的结构化原因，不能让正常 resolve 的空响应绕过 gate。
      reason: input.failure.reason === "unknown" ? input.failure.retryReason : input.failure.reason,
      retryable: true,
      statusCode: input.failure.statusCode,
    });
    return typeof decision === "boolean" ? { shouldYield: decision } : decision;
  } catch (error) {
    // Failover policy 读取失败不能遮蔽原始 Provider 错误；保留既有重试是最安全的降级。
    input.logger?.warn("Failed to evaluate model retry failover gate", {
      attempt: input.attempt,
      event: "model.failover_retry_gate.failed",
      error: error instanceof Error ? error.message : String(error),
      modelId: String(input.resolved.modelId),
      providerId: String(input.resolved.providerId),
    });
    return noRetryYield();
  }
}

export function retryYieldDecisionContext(
  decision: ModelRetryYieldDecision,
  consumedRetryAttempts: number,
): Record<string, unknown> {
  return {
    retryYieldedToFailover: true,
    retryYieldConsumedRetryAttempts: Math.max(0, Math.trunc(consumedRetryAttempts)),
    ...(decision.policyRevision === undefined
      ? {}
      : { retryYieldPolicyRevision: decision.policyRevision }),
    ...(decision.sourceCommandId === undefined
      ? {}
      : { retryYieldSourceCommandId: decision.sourceCommandId }),
  };
}

function noRetryYield(): ModelRetryYieldDecision {
  return { shouldYield: false };
}
