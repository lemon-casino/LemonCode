import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  traceContextToLogContext,
  estimateMessageTokens,
  hasEnoughMessagesToCompact,
  shouldAutoCompact,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  AutoCompactTokenOverride,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  throwIfTurnAborted,
  isTurnCancellationError,
  buildRuntimeProviderRequestMessages,
} from "../helpers/index.js";
import type { RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { autoCompactDecisionLogContext } from "./compact-log-context.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import type {
  AutoCompactLoopContext,
  AutoCompactOutcome,
  CompactAttemptOutcome,
  ReactiveCompactLoopContext,
} from "./turn-loop-state.js";
import { findLatestCommittedAssistantUsage } from "./turn-model-step-usage.js";
export { executeManualCompact } from "./compact-manual.js";

export async function autoCompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: AutoCompactLoopContext,
): Promise<AutoCompactOutcome> {
  throwIfTurnAborted(abortSignal);

  const config: AutoCompactPolicyConfig = {
    contextWindow: context.model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  const activeEntries = context.turnRequestState.entries;
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  const decision = shouldAutoCompact({
    messages: activeMessages,
    config,
    consecutiveFailures: this.autoCompactConsecutiveFailures,
    tokenOverride,
  });

  if (!decision.shouldCompact) {
    this.logger?.debug("Auto compact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.skipped",
      module: "core.runtime",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      phase: context.phase,
      reason: decision.reason,
      ...autoCompactDecisionLogContext(decision),
    });
    return "skipped";
  }

  if (context.rapidRefill.shouldBlock) {
    this.logger?.warn("Autocompact rapid-refill breaker tripped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.rapid_refill_breaker",
      compactReason: context.compactReason,
      consecutiveRapidRefills: context.rapidRefill.consecutiveRapidRefills,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      status: "failed",
      toolTurnsSinceCompact: context.rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Auto,
      ...autoCompactDecisionLogContext(decision),
    });
    return "rapid_refill_blocked";
  }

  this.logger?.info("Auto compact started", {
    ...traceContextToLogContext(turnTraceContext),
    event: "compact.auto.started",
    compactReason: context.compactReason,
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    ...autoCompactDecisionLogContext(decision),
  });

  try {
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        compactContextTelemetry: {
          inputTokens: decision.tokenCount,
          policyContextWindowTokens: decision.contextWindow,
          thresholdTokens: decision.threshold,
          tokenSource: decision.tokenSource,
        },
        autoCompactThreshold: decision.threshold,
        compactReason: context.compactReason,
        phase: context.phase,
        trigger: CompactTrigger.Auto,
        activeEntries,
        ...(context.model ? { model: context.model } : {}),
      },
    );
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    context.turnRequestState.entries = compactResult.entries;
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Auto compact completed", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.completed",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "compacted";
  } catch (error) {
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Auto compact failed", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.auto.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "failed";
  }
}

function buildProviderUsageTokenOverride(
  messages: RunModelTextRequestOptions["messages"],
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[],
): AutoCompactTokenOverride | undefined {
  const latestUsage = findLatestCommittedAssistantUsage(sourceEntries);
  if (!latestUsage || latestUsage.messageIndex >= messages.length) {
    return undefined;
  }

  const { baseline, messageIndex } = latestUsage;
  const incrementalStartIndex =
    baseline.contextUsageTokens === undefined ? messageIndex : messageIndex + 1;
  const incrementalTokenCount = estimateMessageTokens(messages.slice(incrementalStartIndex));
  // usage 归属于已提交 assistant，反向扫描可随 history replacement 自然移动，
  // 不再依赖可能失效的绝对 message cursor。若 output 是否存在已被历史归一化抹平，
  // 则 provider input 只覆盖 assistant 之前的请求，assistant 本身仍进入本地增量。
  const providerBaseTokenCount = baseline.contextUsageTokens ?? baseline.inputTokens;
  return {
    baseTokenCount: providerBaseTokenCount,
    cacheReadTokens: baseline.cacheReadTokens,
    cacheWriteTokens: baseline.cacheWriteTokens,
    contextUsageTokenCount: baseline.contextUsageTokens,
    incrementalTokenCount,
    outputTokens: baseline.outputTokens,
    source: "provider_usage",
    tokenCount: providerBaseTokenCount + incrementalTokenCount,
  };
}

export function estimateCurrentModelInputTokens(
  messages: RunModelTextRequestOptions["messages"],
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[] = [],
): number {
  return (
    buildProviderUsageTokenOverride(messages, sourceEntries)?.tokenCount ??
    estimateMessageTokens(messages)
  );
}

export async function reactiveCompactAfterContextExceeded(
  this: AgentRuntimeInternal,
  originalError: unknown,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: ReactiveCompactLoopContext,
): Promise<CompactAttemptOutcome> {
  throwIfTurnAborted(abortSignal);

  if (this.config.compact?.enabled === false) {
    this.logger?.warn("Reactive compact skipped because compact is disabled", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context.rapidRefillCount,
      reason: "disabled",
    });
    return "skipped";
  }

  const activeEntries = context.activeEntries ?? context.turnRequestState.entries;
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  if (!hasEnoughMessagesToCompact(activeMessages)) {
    this.logger?.warn("Reactive compact skipped because there is not enough history", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      messageCount: activeMessages.length,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
      reason: "not_enough_messages",
    });
    return "skipped";
  }

  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  const contextWindow = context.model.properties.contextWindow;

  this.logger?.warn("Reactive compact started after model context overflow", {
    ...traceContextToLogContext(turnTraceContext),
    errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
    event: "compact.reactive.started",
    messageCount: activeMessages.length,
    modelStepIndex: context?.modelStepIndex,
    module: "core.runtime",
    rapidRefillCount: context?.rapidRefillCount,
    tokenCount: estimateMessageTokens(activeMessages),
  });

  try {
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        compactContextTelemetry: {
          inputTokens: tokenOverride?.tokenCount ?? estimateMessageTokens(activeMessages),
          policyContextWindowTokens:
            contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
              ? Math.floor(contextWindow)
              : DEFAULT_COMPACT_CONTEXT_WINDOW,
          tokenSource: tokenOverride?.source ?? "estimate",
        },
        compactReason: CompactReason.ProviderOverflow,
        initialPromptTooLongCause: originalError,
        phase: CompactPhase.Reactive,
        trigger: CompactTrigger.Reactive,
        activeEntries,
        model: context.model,
      },
    );
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    context.turnRequestState.entries = compactResult.entries;
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Reactive compact completed; retrying model request", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.reactive.completed",
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "compacted";
  } catch (error) {
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Reactive compact failed after model context overflow", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.reactive.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "failed";
  }
}
