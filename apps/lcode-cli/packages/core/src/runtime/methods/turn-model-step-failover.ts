import { createHash } from "node:crypto";
import { TurnMachineImpl } from "../deps.js";
import type { MessageId, ModelToolContract } from "../deps.js";
import type { RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import {
  activateExecutionFailoverAtSafeBoundary,
  executionModelSelectionIdentity,
  modelSelectionFromModel,
  type ExecutionFailoverRetryYieldClaim,
} from "./model-failover-router.js";

export async function closeFailedModelStepAndActivateFailover(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    model: RegularTurnLoopState["model"];
    modelTraceContext: RegularTurnLoopState["turnTraceContext"];
    persistAssistant?: boolean;
    reasonCode:
      | "userRequested"
      | "network.transport_unavailable"
      | "provider.service_unavailable"
      | "provider.rate_limited"
      | "provider.authentication_failed"
      | "provider.stream_unrecoverable"
      | "provider.context_capacity";
  },
): Promise<{ activated: boolean; failedStepClosed: boolean }> {
  let failedStepClosed = false;
  const activation = await activateExecutionFailoverAtSafeBoundary(this, state, {
    beforeActivate: async () => {
      if (failedStepClosed) return;
      await closeFailedModelStep.call(this, state, {
        assistantCreatedAt: input.assistantCreatedAt,
        assistantMessageId: input.assistantMessageId,
        finish: "provider_failover_discarded",
        model: input.model,
        modelTraceContext: input.modelTraceContext,
        persistAssistant: input.persistAssistant,
      });
      failedStepClosed = true;
    },
    reasonCode: input.reasonCode,
    traceContext: input.modelTraceContext,
  });
  return { activated: activation === "activated", failedStepClosed };
}

export async function closeRetryYieldRecoveryStepIfNeeded(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    failedStepClosed: boolean;
    model: RegularTurnLoopState["model"];
    modelTraceContext: RegularTurnLoopState["turnTraceContext"];
  },
): Promise<void> {
  if (input.failedStepClosed) return;
  await closeFailedModelStep.call(this, state, {
    assistantCreatedAt: input.assistantCreatedAt,
    assistantMessageId: input.assistantMessageId,
    finish: "provider_retry_yield_recovered",
    model: input.model,
    modelTraceContext: input.modelTraceContext,
  });
}

export function retainRetryYieldContinuation(
  state: RegularTurnLoopState,
  claim: ExecutionFailoverRetryYieldClaim,
  model: RegularTurnLoopState["model"],
  requestIdentity: string,
): void {
  state.pendingModelRetryContinuation = {
    consumedRetryAttempts: claim.consumedRetryAttempts,
    requestIdentity,
    selectionIdentity: executionModelSelectionIdentity(modelSelectionFromModel(model)),
  };
}

export function consumePendingModelRetryContinuation(
  state: RegularTurnLoopState,
  input: { model: RegularTurnLoopState["model"]; requestIdentity: string },
): number | undefined {
  const pending = state.pendingModelRetryContinuation;
  // continuation 是一次性能力：任何不匹配都直接丢弃，不能延后污染后续新请求。
  state.pendingModelRetryContinuation = undefined;
  return pending &&
    pending.selectionIdentity ===
      executionModelSelectionIdentity(modelSelectionFromModel(input.model)) &&
    pending.requestIdentity === input.requestIdentity
    ? pending.consumedRetryAttempts
    : undefined;
}

export function createModelRetryRequestIdentity(input: {
  maxOutputTokens: number;
  messages: RunModelTextRequestOptions["messages"];
  model: RegularTurnLoopState["model"];
  tools: ModelToolContract[];
}): string {
  // continuation 只存在内存中，但仍只保存摘要；busy input、compact、reminder 或工具契约
  // 任一变化都会生成不同 identity，旧失败的 attempt offset 不能缩减新请求预算。
  const tools = input.tools.map(({ execute: _execute, ...tool }) => tool);
  return createHash("sha256")
    .update(
      JSON.stringify({
        maxOutputTokens: input.maxOutputTokens,
        messages: input.messages,
        selection: modelSelectionFromModel(input.model),
        tools,
      }),
    )
    .digest("hex");
}

async function closeFailedModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    finish: string;
    model: RegularTurnLoopState["model"];
    modelTraceContext: RegularTurnLoopState["turnTraceContext"];
    persistAssistant?: boolean;
  },
): Promise<void> {
  if (input.persistAssistant !== false) {
    await this.persistAssistantMessage(
      input.assistantMessageId,
      state.currentUserMessageId,
      input.assistantCreatedAt,
      { completed: Date.now(), finish: input.finish },
      input.modelTraceContext,
      input.model,
    );
  }
  state.modelResponse = "";
  state.modelStepCount += 1;
  recordModelHistoryRound(state);
  state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
}
