import {
  CoreErrorType,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  TurnMachineImpl,
} from "../deps.js";
import type { HookRunResult, MessageId, SessionEvent, SessionGoal } from "../deps.js";
import { createTurnFailureError, appendTurnOutcomeEvent } from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { type RegularTurnLoopState } from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { cleanupTurnBackgroundBash } from "./background.js";
import { recordMemoryEffectTurn } from "./memory-effect-observation.js";
import type { TraceContext, TraceId, TurnId } from "../deps.js";

export async function failRegularTurn(
  this: AgentRuntimeInternal,
  error: unknown,
  context: {
    activeTurn: ActiveTurnSteeringState | undefined;
    events: SessionEvent[];
    loopState: RegularTurnLoopState | undefined;
    options: ExecuteTurnOptions | undefined;
    startedTarget: SessionGoal | null;
    targetRunInputID: string;
    turnAbortSignal: AbortSignal;
    turnId: TurnId;
    turnMachine: TurnMachineImpl;
    turnStartedAtMs: number;
    turnTraceContext: TraceContext;
    userMessageId: MessageId | undefined;
  },
  updateStartedTarget: (target: SessionGoal | null) => void,
): Promise<never> {
  const {
    activeTurn,
    events,
    loopState,
    options,
    startedTarget,
    targetRunInputID,
    turnAbortSignal,
    turnId,
    turnMachine,
    turnStartedAtMs,
    turnTraceContext,
    userMessageId,
  } = context;
  // 临时预览在失败/取消时同样属于本轮资源，不能只在成功路径清理后留住后台服务。
  await cleanupTurnBackgroundBash(this, turnId, turnTraceContext);
  const coreError = createTurnFailureError(error, turnAbortSignal, "Turn execution failed");
  const preserveQueueAutoDrainOnCancel =
    coreError.type === CoreErrorType.TurnCancelled &&
    this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
  const finishedTarget = await this.finishTargetTurnAccounting({
    endedAtMs: Date.now(),
    inputID: targetRunInputID,
    startedTarget,
    status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
    traceContext: turnTraceContext,
  });
  if (finishedTarget?.targetID === startedTarget?.targetID) {
    updateStartedTarget(finishedTarget);
  }
  if (coreError.type === CoreErrorType.TurnCancelled) {
    await this.pauseActiveTargetForCancellation(turnTraceContext);
    if (activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn,
        events,
        reasonCode: "guide.turnInterrupted",
        traceContext: turnTraceContext,
      });
    }
  }
  // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
  // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
  // 保留排队输入，等待用户显式继续。
  if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
    const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
    if (pendingInputs.length > 0) {
      this.queueAutoDrain = false;
      this.queueExternalDrainActive = false;
    }
  } else if (
    activeTurn &&
    coreError.type === CoreErrorType.TurnCancelled &&
    !preserveQueueAutoDrainOnCancel &&
    activeTurn.pendingInputs.length > 0
  ) {
    // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
    // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
    // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
    this.queueAutoDrain = false;
    this.queueExternalDrainActive = false;
  }

  // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
  const backgroundSubagentResultConsumed =
    options?.backgroundSubagentResultConsumed === true ||
    loopState?.backgroundSubagentResultConsumed === true;
  const workflowResultConsumed =
    options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
  await appendTurnOutcomeEvent(this, {
    coreError,
    events,
    durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
    turnPhase: turnMachine.state.phase,
    inputId: options?.inputId,
    traceContext: turnTraceContext,
    fallbackMessage: "Turn execution failed",
    logEvent: "turn.failed",
    logLabel: "Turn",
    preserveQueueAutoDrainOnCancel,
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    historyRoundCount: loopState?.historyRoundCount,
  });
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    error: coreError,
    events,
    startedAt: turnStartedAtMs,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
    traceContext: turnTraceContext,
    turnId,
    userMessageId,
  });
  await recordMemoryEffectTurn(this, {
    state: loopState,
    events,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
  });
  throw coreError;
}

export async function completeHookBlockedTurn(
  this: AgentRuntimeInternal,
  context: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    options: ExecuteTurnOptions | undefined;
    startedTarget: SessionGoal | null;
    targetRunInputID: string;
    traceId: TraceId;
    turnId: TurnId;
    turnMachine: TurnMachineImpl;
    turnStartedAtMs: number;
    turnTraceContext: TraceContext;
    userPromptHookResult: HookRunResult;
  },
  updateTurnMachine: (machine: TurnMachineImpl) => void,
): Promise<TurnResult> {
  const {
    activeTurn,
    events,
    options,
    startedTarget,
    targetRunInputID,
    traceId,
    turnId,
    turnStartedAtMs,
    turnTraceContext,
    userPromptHookResult,
  } = context;
  const response = userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
  if (activeTurn) activeTurn.steerable = false;
  const turnMachine = new TurnMachineImpl(context.turnMachine.complete(response, "success"));
  // Hook 的完成态在持久化之前即属于本轮；后续写入失败时仍由外层同一状态处理失败。
  updateTurnMachine(turnMachine);
  const turnUsage = createModelUsageSummaryFromEvents(events);
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response,
      tokenCount: 0,
      usage: turnUsage,
      toolCallCount: 0,
      duration: Date.now() - turnMachine.state.startedAt.getTime(),
      resultType: "success",
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
  });
  this.turnNumber++;
  const projection = await this.rebuildProjection();
  await this.accountTargetTurnCompletion({
    inputID: targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  return {
    response,
    turnId,
    traceId,
    usage: turnUsage,
    events,
    projection,
  };
}
