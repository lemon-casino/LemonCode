import {
  CompactTrigger,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  SessionEventType,
  createChildTraceContext,
  traceContextToLogContext,
  buildCompactPrompt,
} from "../deps.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";
import {
  getRuntimeEntriesToSummarize,
  selectCompactEntriesAfterPromptTooLong,
  isTurnCancellationError,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  logCompactMediaRetryProjection,
} from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
} from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { filterOutputTokenContinuationEntries } from "./turn-output-token-continuation.js";
import type {
  CompactConversationAttempt,
  CompactConversationSelection,
  CompactSummaryAttemptResult,
} from "./compact-active-types.js";

export async function requestCompactConversationSummary(
  this: AgentRuntimeInternal,
  context: CompactConversationAttempt,
  selection: CompactConversationSelection,
): Promise<CompactSummaryAttemptResult> {
  const {
    activeEntries,
    attempt,
    compactModel,
    compactTools,
    compactTimeline,
    customInstructions,
    events,
    options,
    preCompactTokenCount,
    trigger,
    turnTraceContext,
    useMidConversationSystem,
  } = context;
  let currentSelection = selection;
  let preservedEntries = currentSelection.preservedEntries;
  let entriesForSummary = currentSelection.entriesForSummary;
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  const modelTraceContext = createChildTraceContext(turnTraceContext, {
    attributes: {
      model: `${compactModel.providerId}/${compactModel.modelId}`,
      querySource: "compact",
    },
  });
  const compactPrompt = buildCompactPrompt(customInstructions);
  let result: RuntimeModelTextResult;
  let compactPromptTooLongAttempts = 0;
  let stripMediaForSummary = false;
  const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
    const reselected = selectCompactEntriesAfterPromptTooLong({
      currentGroupsPreserved: currentSelection.groupsPreserved,
      entries: activeEntries,
      promptTooLongCause: cause,
      trigger,
      useMidConversationSystem,
    });
    if (!reselected) return false;

    compactPromptTooLongAttempts += 1;
    currentSelection = reselected;
    preservedEntries = reselected.preservedEntries;
    entriesForSummary = reselected.entriesForSummary;
    entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
    return true;
  };
  const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
    if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

    const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
      attempt: compactPromptTooLongAttempts,
      cause,
      entriesForSummary,
      logger: this.logger,
      traceContext: modelTraceContext,
      useMidConversationSystem,
    });
    if (!truncated) return false;

    compactPromptTooLongAttempts += 1;
    entriesForSummary = truncated;
    entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
    return true;
  };

  while (true) {
    const requestMessages = buildCompactSummaryRequestMessages(entriesForSummary, compactPrompt, {
      useMidConversationSystem,
    });
    const recordableEntries = filterOutputTokenContinuationEntries(entriesForSummary);
    const recordableRequestMessages =
      recordableEntries === entriesForSummary
        ? requestMessages
        : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
            useMidConversationSystem,
          });
    // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
    // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
    const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
      requestMessages,
      compactModel.properties.inputFormat,
    );
    logMediaCapabilityProjection(
      this.logger,
      modelTraceContext,
      mediaPolicyProjection.capabilityProjection,
      {
        event: "compact.request.media_capability_projection",
        message: "Compact request media capability projection",
        model: `${compactModel.providerId}/${compactModel.modelId}`,
      },
    );
    logMediaBudgetProjection(
      this.logger,
      modelTraceContext,
      mediaPolicyProjection.mediaBudgetProjection,
      {
        event: "compact.request.media_projection",
        message: "Compact request media budget projection",
      },
    );
    let projectedRequestMessages = mediaPolicyProjection.messages;
    let projectedRecordableMessages =
      recordableRequestMessages === requestMessages
        ? projectedRequestMessages
        : projectMessagesForModelMediaPolicy(
            recordableRequestMessages,
            compactModel.properties.inputFormat,
          ).messages;
    if (stripMediaForSummary) {
      // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
      const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
      projectedRequestMessages = mediaProjection.messages;
      projectedRecordableMessages =
        recordableRequestMessages === requestMessages
          ? projectedRequestMessages
          : projectCompactMediaForRetry(projectedRecordableMessages).messages;
      logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
    }

    const modelRequestEvent = this.createEvent(
      SessionEventType.ModelRequest,
      {
        // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
        // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
        messages: projectedRecordableMessages,
        providerId: String(compactModel.providerId),
        modelId: String(compactModel.modelId),
        querySource: "compact",
        toolCount: compactTools.length,
        compactPromptTooLongRetry: compactPromptTooLongAttempts,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelRequestEvent, modelTraceContext);
    events.push(modelRequestEvent);
    const modelStartedAt = Date.now();
    const networkEventStartIndex = events.length;
    const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
    const compactModelRequest = {
      abortSignal: options.abortSignal,
      maxOutputTokens: compactSummaryMaxOutputTokens,
      messages: projectedRequestMessages,
      metadata: traceContextToLogContext(modelTraceContext),
      modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(this.config.taskType),
      modelCall: {
        attributes: {
          compactionOuterAttempt: attempt,
          compactionTrigger: trigger,
        },
        operation: "context_compaction" as const,
        operationId: compactTimeline.operationId,
      },
      statusSink: this.createModelStatusSink(modelTraceContext, events),
      // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
      // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
      preserveProviderStreamBoundaries: true,
      traceContext: modelTraceContext,
      tools: compactTools,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal: options.abortSignal,
        model: compactModel,
        traceContext: modelTraceContext,
      }),
    };

    try {
      result = await runCompactSummaryModelRequest({
        logger: this.logger,
        model: compactModel,
        request: compactModelRequest,
      });
    } catch (error) {
      await recordModelUsageFact(this, {
        attemptIndex: compactPromptTooLongAttempts,
        error,
        events,
        model: compactModel,
        networkEventStartIndex,
        querySource: "compact",
        startedAt: modelStartedAt,
        status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
        traceContext: modelTraceContext,
      });
      if (isTurnCancellationError(error, options.abortSignal)) {
        throw error;
      }
      if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
        stripMediaForSummary = true;
        this.logger?.info("Compact summary hit media-size error; retrying with stripped media", {
          ...traceContextToLogContext(modelTraceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.request.media_too_large.retry",
          module: "core.runtime",
        });
        continue;
      }
      if (isModelContextExceededError(error)) {
        if (reselectEntriesAfterPromptTooLong(error)) continue;
        if (truncateEntriesAfterPromptTooLong(error)) continue;
        throw createCompactPromptTooLongError({
          attempt: compactPromptTooLongAttempts,
          cause: error,
          preCompactTokenCount,
        });
      }
      throw error;
    }

    await recordModelUsageFact(this, {
      attemptIndex: compactPromptTooLongAttempts,
      events,
      model: compactModel,
      networkEventStartIndex,
      querySource: "compact",
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: this.extractToolCallsFromResult(result).length,
      traceContext: modelTraceContext,
    });
    const contextError = createCompactContextExceededFinishError(result);
    if (contextError) {
      // compact summary 也可能以 finishReason 返回超窗而不是 throw；
      // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
      if (reselectEntriesAfterPromptTooLong(contextError)) continue;
      if (truncateEntriesAfterPromptTooLong(contextError)) continue;
      throw createCompactPromptTooLongError({
        attempt: compactPromptTooLongAttempts,
        cause: contextError,
        preCompactTokenCount,
      });
    }
    break;
  }

  return { currentSelection, entriesToSummarize, modelTraceContext, preservedEntries, result };
}

function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 20K 上限中的较小值。
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}
