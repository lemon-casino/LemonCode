import { beginLocalTurnPreparation } from "@lcode/contracts";
import {
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createPartId,
} from "../deps.js";
import type { MessageId, ModelNetworkStatusEvent, ModelToolContract } from "../deps.js";
import { type RuntimeMessageEntry } from "../../agent/message-history.js";
import { throwIfTurnAborted, isTurnCancellationError } from "../helpers/index.js";
import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelStreamSnapshot,
  RuntimeModelTextResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { captureAssistantPersistenceAnchor } from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { querySourceForTask } from "./turn-model-step-usage.js";
import { estimateCurrentModelInputTokens } from "./compact.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "./model-token-limits.js";
import { shouldYieldRetryToExecutionFailover } from "./model-failover-router.js";
import type { ModelStepExecution, ModelStepResult } from "./turn-model-step-types.js";
import {
  consumePendingModelRetryContinuation,
  createModelRetryRequestIdentity,
} from "./turn-model-step-failover.js";
import { recoverFailedModelStep } from "./turn-model-step-failure.js";
import { commitModelStepResult } from "./turn-model-step-result.js";
export {
  closeFailedModelStepAndActivateFailover,
  closeRetryYieldRecoveryStepIfNeeded,
  retainRetryYieldContinuation,
  consumePendingModelRetryContinuation,
  createModelRetryRequestIdentity,
} from "./turn-model-step-failover.js";
export { runReactiveCompactAttempt } from "./turn-model-step-compact.js";

export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
): Promise<ModelStepResult> {
  const assistantMessageId = createMessageId();
  const stepTelemetry = this.agentTelemetry.step({
    stepId: assistantMessageId,
    stepIndex: state.modelStepCount,
  });
  return stepTelemetry.run(async () => {
    try {
      const result = await runModelBackedTurnStepImpl.call(
        this,
        state,
        options,
        assistantMessageId,
      );
      stepTelemetry.finishCompleted(
        result === "output_continuation"
          ? "model_completed"
          : result === "continue"
            ? "tool_requested"
            : "turn_completed",
      );
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, state.turnAbortSignal)) {
        stepTelemetry.finishCancelled("abort_signal");
      } else {
        stepTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

export async function persistTurnModelRequestEvent(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    model: RegularTurnLoopState["model"];
    modelTraceContext: RegularTurnLoopState["turnTraceContext"];
    querySource: string;
    recordedMessages: RunModelTextRequestOptions["messages"];
    toolCount: number;
  },
): Promise<void> {
  const modelRequestEvent = runtime.createEvent(
    SessionEventType.ModelRequest,
    {
      // 自动续写与 memory recall 都只属于 live request，持久化只接受 recorded projection。
      messages: input.recordedMessages,
      providerId: String(input.model.providerId),
      modelId: String(input.model.modelId),
      querySource: input.querySource,
      toolCount: input.toolCount,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    input.modelTraceContext,
  );
  await runtime.appendEvent(modelRequestEvent, input.modelTraceContext);
  state.events.push(modelRequestEvent);
}

async function runModelBackedTurnStepImpl(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
  assistantMessageId: MessageId,
): Promise<ModelStepResult> {
  const model = state.model;
  const modelStepIndex = state.modelStepCount;
  const modelStartedAt = Date.now();
  const assistantCreatedAt = modelStartedAt;
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  const querySource = querySourceForTask(this.config.taskType);
  const executionModelSelection = { providerId: model.providerId, modelId: model.modelId };
  // 请求预算由 Agent 执行链显式决定。普通 Turn 选择打满模型声明的上限，
  // ModelFactory 不再把该请求参数伪装成长期 ModelSelection/Active Model 状态。
  const executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
  const executionContextWindow = model.properties.contextWindow;
  const baselineMaxOutputTokens = resolveNormalRequestMaxOutputTokens({
    modelMaxOutputTokens: executionMaxOutputTokens,
  });
  const requestMaxOutputTokens = resolveModelStepMaxOutputTokens({
    baselineMaxOutputTokens,
    contextWindow: executionContextWindow,
    estimatedCurrentUsage: estimateCurrentModelInputTokens(options.messages, options.sourceEntries),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  });
  let retryRequestIdentity: string | undefined;
  const getRetryRequestIdentity = (): string =>
    (retryRequestIdentity ??= createModelRetryRequestIdentity({
      maxOutputTokens: requestMaxOutputTokens,
      messages: options.messages,
      model,
      tools: options.tools,
    }));
  // 正常请求不序列化/哈希长上下文；只有待消费 continuation 或真实 yield claim 才计算。
  const retryAttemptOffset = state.pendingModelRetryContinuation
    ? consumePendingModelRetryContinuation(state, {
        model,
        requestIdentity: getRetryRequestIdentity(),
      })
    : undefined;
  const modelTraceContext = createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      querySource,
    },
  });

  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  await persistTurnModelRequestEvent(this, state, {
    model,
    modelTraceContext,
    querySource,
    recordedMessages: options.recordedMessages,
    toolCount: options.tools.length,
  });
  finishPersistence();
  const streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
    assistantMessageId,
    model,
    traceContext: modelTraceContext,
  });
  const networkEventStartIndex = state.events.length;
  let latestStreamSnapshot: RuntimeModelStreamSnapshot = { reasoning: [], text: "" };
  const streamRecoveryRequest = state.pendingStreamRecoveryRequest;
  state.pendingStreamRecoveryRequest = undefined;
  let latestModelRequestId: string | undefined;
  let latestFailedModelRequestId: string | undefined;
  const recordModelNetworkStatus = (event: ModelNetworkStatusEvent): void => {
    if (event.type === "model_request_started") {
      latestModelRequestId = event.requestId;
      return;
    }
    if (event.type === "model_stream_stalled" || event.type === "model_request_failed") {
      latestFailedModelRequestId = event.requestId;
    }
  };

  const execution: ModelStepExecution = {
    assistantCreatedAt,
    assistantMessageId,
    assistantPersistenceAnchor,
    executionContextWindow,
    executionModelSelection,
    getRetryRequestIdentity,
    model,
    modelStartedAt,
    modelStepIndex,
    modelTraceContext,
    networkEventStartIndex,
    querySource,
    streamingToolCoordinator,
  };
  let result: RuntimeModelTextResult;
  try {
    result = await this.runModelTextRequest({
      abortSignal: state.turnAbortSignal,
      assistantMessageId,
      events: state.events,
      maxOutputTokens: requestMaxOutputTokens,
      latestRealUserMessageIndex: options.latestRealUserMessageIndex,
      messages: options.messages,
      sourceEntries: options.sourceEntries,
      model,
      requestDependencies: state.modelRequestDependencies,
      retryAttemptOffset,
      shouldYieldRetryToFailover: (input) =>
        shouldYieldRetryToExecutionFailover(
          this,
          state,
          model,
          input,
          options.sourceEntries,
          state.modelRequestDependencies,
        ),
      onStreamSnapshot: (snapshot) => {
        latestStreamSnapshot = snapshot;
      },
      onModelNetworkStatus: recordModelNetworkStatus,
      onStreamReasoningDelta: (text) => streamingToolCoordinator.recordReasoningDelta(text),
      onStreamTextDelta: (text) => streamingToolCoordinator.recordTextDelta(text),
      onStreamToolCall: (toolCall) => streamingToolCoordinator.accept(toolCall),
      streamRecovery: streamRecoveryRequest,
      tools: options.tools,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(state.turnAbortSignal);
  } catch (error) {
    return await recoverFailedModelStep.call(this, state, options, execution, {
      error,
      latestStreamSnapshot,
      failedRequestId: latestFailedModelRequestId ?? latestModelRequestId,
    });
  }

  return await commitModelStepResult.call(this, state, options, execution, result);
}
