import {
  SessionEventType,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionGoal, SessionEvent, TraceContext, TurnId } from "../deps.js";
import type {
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "@lcode/contracts";
import { isMemoryReviewOperation } from "../../memory/extraction.js";
import type { ExecuteTurnOptions, TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { maybeStartDeferredSessionTitleGeneration } from "./session-title.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { cleanupTurnBackgroundBash } from "./background.js";

export async function completeRegularTurn(
  this: AgentRuntimeInternal,
  loopState: RegularTurnLoopState,
  completion: {
    displayInput: string;
    options: ExecuteTurnOptions | undefined;
    shouldRetryTitleGenerationAfterTurn: boolean;
    startedTarget: SessionGoal | null;
    targetRunInputID: string;
    turnStartedAtMs: number;
    turnTraceContext: TraceContext;
  },
): Promise<TurnResult> {
  const {
    displayInput,
    options,
    shouldRetryTitleGenerationAfterTurn,
    startedTarget,
    targetRunInputID,
    turnStartedAtMs,
    turnTraceContext,
  } = completion;
  // guide 只推进下一次模型请求的 queryId；轮次收尾仍使用 admission 时的 trace，不能借 loop 的新 query。
  const { events, traceId, turnId, turnMachine, userMessageId } = loopState;
  const turnUsage = createModelUsageSummaryFromEvents(events);
  // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
  // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
  await this.accountTargetTurnCompletion({
    inputID: targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
    await persistStableForkCompletionBoundary(this, {
      boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
      startMessageId: loopState.stableProductStartMessageId,
      historyRoundCount: loopState.historyRoundCount,
      traceContext: turnTraceContext,
    });
  }
  if (loopState.stableBoundaryAssistantMessageId) {
    await appendBrowserTurnScreenshot(this, loopState, loopState.stableBoundaryAssistantMessageId);
  }
  // 主轮成功时先结算本轮临时后台 Bash，预览服务显式保留；
  // 进程生命周期由 Runtime 拥有，UI 只消费之后的完成事实。
  await cleanupTurnBackgroundBash(this, turnId, turnTraceContext);
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response: loopState.modelResponse,
      tokenCount: loopState.tokenCount,
      usage: turnUsage,
      toolCallCount: loopState.toolCallCount,
      historyRoundCount: loopState.historyRoundCount,
      duration: Date.now() - turnMachine.state.startedAt.getTime(),
      resultType: "success",
      ...(loopState.backgroundSubagentResultConsumed
        ? { backgroundSubagentResultConsumed: true }
        : {}),
      ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
      cacheStats: this.messageHistory.getCacheStats(),
      inputId: options?.inputId,
    },
    turnTraceContext,
  );
  await this.appendEvent(completeEvent, turnTraceContext);
  events.push(completeEvent);
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    events,
    startedAt: turnStartedAtMs,
    status: "completed",
    traceContext: turnTraceContext,
    turnId,
    userMessageId,
  });
  if (shouldRetryTitleGenerationAfterTurn && userMessageId) {
    // 需要请求前刷新 provider runtime headers 的模型
    // 若在主 turn 前生成标题，会先占用鉴权刷新窗口，导致真正的用户消息失败。
    maybeStartDeferredSessionTitleGeneration.call(
      this,
      displayInput,
      userMessageId,
      turnTraceContext,
    );
  }
  this.turnNumber++;

  const projection = await this.rebuildProjection();
  this.logger?.info("Turn completed", {
    ...traceContextToLogContext(turnTraceContext),
    durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
    event: "turn.completed",
    module: "core.runtime",
    status: "completed",
    toolCallCount: loopState.toolCallCount,
  });
  // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
  if (
    options?.modelExecution?.memoryExtraction !== "skip" &&
    !isAutomationMutationRestrictedTurn(loopState) &&
    !isOffPeakCreateRestrictedTurn(loopState) &&
    !containsForegroundMemoryReview(events, this.sessionId, turnId)
  ) {
    scheduleProjectMemoryExtraction(this, {
      model: loopState.model,
      traceContext: turnTraceContext,
    });
  }

  const result: TurnResult = {
    response: loopState.modelResponse,
    turnId,
    traceId,
    usage: turnUsage,
    events,
    projection,
  };
  return result;
}

function containsForegroundMemoryReview(
  events: readonly SessionEvent[],
  sessionId: SessionEvent["sessionId"],
  turnId: TurnId,
): boolean {
  const calls = new Map<string, ToolCallScheduledPayload>();
  const scopedEvents = events.filter(
    (event) =>
      event.sessionId === sessionId && (event.turnId === undefined || event.turnId === turnId),
  );
  for (const event of scopedEvents) {
    if (event.type === SessionEventType.ToolCallScheduled) {
      const call = event.payload as ToolCallScheduledPayload;
      calls.set(call.toolCallId, call);
    }
  }
  // Scheduled 只证明声明；Started/Result 才证明工具已发生。action 取同 callId 的结构化输入，
  // 不从用户文字、最终回答或工具输出猜测；后续轮的持久证据隔离由 extraction 快照负责。
  return scopedEvents.some((event) => {
    if (
      event.type !== SessionEventType.ToolCallStarted &&
      event.type !== SessionEventType.ToolCallResult
    )
      return false;
    const payload = event.payload as ToolCallStartedPayload | ToolCallResultPayload;
    const call = calls.get(payload.toolCallId);
    const name = "toolName" in payload ? (payload.toolName ?? call?.toolName) : call?.toolName;
    return name !== undefined && isMemoryReviewOperation(name, call?.input);
  });
}
