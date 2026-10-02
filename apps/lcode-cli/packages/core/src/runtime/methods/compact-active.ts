import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  SessionEventType,
  isCoreError,
  createMessageId,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  compactFailureReasonFromError,
  estimateRuntimeEntryTokens,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesForInitialPromptTooLong,
  throwIfTurnAborted,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { CompactTimelineContext } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import { type RuntimeMessageEntry } from "../../agent/message-history.js";
import { persistCompactTimelineEvent } from "./compact-active-helpers.js";
import { createRuntimeModel } from "./runtime-model.js";
import type { CompactConversationAttempt } from "./compact-active-types.js";
import { requestCompactConversationSummary } from "./compact-active-request.js";
import { commitCompactConversationSummary } from "./compact-active-commit.js";

const AUTO_COMPACT_MAX_ATTEMPTS = 3;
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    activeEntries?: readonly RuntimeMessageEntry[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: AUTO_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto 复用策略决策，Reactive 复用 overflow 路径 activeMessages；其他 trigger 不额外投影。
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  return compactTelemetry.run(async () => {
    try {
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    activeEntries?: readonly RuntimeMessageEntry[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  const entriesForSummary = initialSelection.entriesForSummary;
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  // 止血原因：massive MCP 工具会把 compact summary request 的 provider context 撑爆。
  // ToolSearch/deferred tools 完成前，仅在工具数超过阈值时让 compact summary 保持无工具。
  await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  const runtimeCompactTools = this.getTools(compactModel);
  const compactTools =
    runtimeCompactTools.length > COMPACT_TOOL_KEEP_MAX_COUNT ? [] : runtimeCompactTools;

  while (true) {
    try {
      const lastSummarizedMessageId = this.latestConversationMessageId;
      const context: CompactConversationAttempt = {
        activeEntries,
        attempt,
        compactModel,
        compactTools,
        compactReason,
        compactTimeline,
        customInstructions,
        events,
        maxAttempts,
        options,
        phase,
        preCompactTokenCount,
        trigger,
        turnTraceContext,
        useMidConversationSystem,
      };
      const summary = await requestCompactConversationSummary.call(this, context, initialSelection);
      return await commitCompactConversationSummary.call(
        this,
        context,
        summary,
        lastSummarizedMessageId,
      );
    } catch (error) {
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}

function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}
