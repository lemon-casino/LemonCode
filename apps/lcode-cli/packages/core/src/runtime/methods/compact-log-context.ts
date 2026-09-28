import type { AutoCompactDecision } from "../../compact/policy.js";

export function autoCompactDecisionLogContext(decision: AutoCompactDecision) {
  return {
    contextWindow: decision.contextWindow,
    effectiveContextWindow: decision.effectiveContextWindow,
    estimatedTokenCount: decision.estimatedTokenCount,
    inputBudgetTokens: decision.effectiveContextWindow,
    maxOutputTokens: decision.maxOutputTokens,
    modelContextBudgetStrategy: decision.modelContextBudgetStrategy,
    outputReserveTokens: decision.outputReserveTokens,
    providerBaseTokenCount: decision.providerBaseTokenCount,
    providerCacheReadTokens: decision.providerCacheReadTokens,
    providerCacheWriteTokens: decision.providerCacheWriteTokens,
    providerContextUsageTokenCount: decision.providerContextUsageTokenCount,
    providerIncrementalTokenCount: decision.providerIncrementalTokenCount,
    providerOutputTokens: decision.providerOutputTokens,
    threshold: decision.threshold,
    thresholdPercent: decision.thresholdPercent,
    tokenCount: decision.tokenCount,
    tokenSource: decision.tokenSource,
  };
}
