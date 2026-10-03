import { TurnMachineImpl } from "../deps.js";
import type { MessageId, SessionEvent } from "../deps.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveTurnRecallQuery, type RegularTurnLoopState } from "./turn-loop-state.js";
import {
  executionModelSelectionIdentity,
  modelSelectionFromModel,
} from "./model-failover-router.js";
import type { Model, TraceContext, TraceId, TurnId } from "../deps.js";

export function createRegularTurnLoopState(
  this: AgentRuntimeInternal,
  context: {
    activeTurn: ActiveTurnSteeringState;
    admittedModel: Model | undefined;
    admittedOutputStyle: AgentRuntimeInternal["config"]["outputStyle"];
    displayInput: string;
    events: SessionEvent[];
    input: string;
    options: ExecuteTurnOptions | undefined;
    submissionModel: Model | undefined;
    traceId: TraceId;
    turnAbortSignal: AbortSignal;
    turnId: TurnId;
    turnMachine: TurnMachineImpl;
    turnTraceContext: TraceContext;
    userMessageId: MessageId;
  },
): RegularTurnLoopState {
  const {
    activeTurn,
    admittedModel,
    admittedOutputStyle,
    displayInput,
    events,
    input,
    options,
    submissionModel,
    traceId,
    turnAbortSignal,
    turnId,
    turnMachine,
    turnTraceContext,
    userMessageId,
  } = context;
  this.messageHistory.setCacheMiss();
  const loopModel = submissionModel ?? admittedModel;
  if (!loopModel) {
    throw new Error("Turn model was not created before execution");
  }
  if (this.activeForegroundExecution) {
    this.activeForegroundExecution.currentModelSelection = modelSelectionFromModel(loopModel);
  }
  const turnRecallQuery = resolveTurnRecallQuery(displayInput, options);
  return {
    activeTurn,
    ...(options?.automationId ? { automationId: options.automationId } : {}),
    // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
    ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
    workflowResultConsumed: options?.workflowResultConsumed === true,
    currentUserMessageId: userMessageId,
    events,
    executionFailoverVisitedModels: new Set([
      executionModelSelectionIdentity(modelSelectionFromModel(loopModel)),
    ]),
    executionFailoverTransitionCount: 0,
    executionFailoverAutomaticTransitionCount: 0,
    executionFailoverUnsafePolicies: new Set(),
    input,
    memoryRecallAttempted: false,
    sessionHistoryRecallAttempted: false,
    ...(turnRecallQuery ? { turnRecallQuery } : {}),
    modelResponse: "",
    model: loopModel,
    ...(options?.modelExecution?.requestDependencies === undefined
      ? {}
      : { modelRequestDependencies: options.modelExecution.requestDependencies }),
    ...(options?.modelExecution?.selectionScope === "execution"
      ? { modelSelectionScope: "execution" as const }
      : {}),
    ...(options?.modelExecution?.subagents && options.intent?.modelSelection
      ? {
          subagentModelOverride: {
            selection: options.intent.modelSelection,
            requestDependencies: options.modelExecution.requestDependencies,
            background: options.modelExecution.subagents.background,
          },
        }
      : {}),
    modelStepCount: 0,
    historyRoundCount: 0,
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallSignature: undefined,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: {
      // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
      // 遵循 MessageHistory 的不可变约定。
      entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
      outputTokenContinuationCount: 0,
    },
    toolDisallowlist: options?.toolDisallowlist,
    traceId,
    turnAbortSignal,
    turnId,
    turnMachine,
    turnOutputStyle: admittedOutputStyle,
    turnTraceContext,
    userMessageId,
  };
}
