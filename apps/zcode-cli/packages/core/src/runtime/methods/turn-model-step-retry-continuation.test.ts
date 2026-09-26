import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageId,
  Model,
  ModelToolContract,
  SessionId,
  TraceContext,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { TurnMachineImpl } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  closeFailedModelStepAndActivateFailover,
  closeRetryYieldRecoveryStepIfNeeded,
  consumePendingModelRetryContinuation,
  createModelRetryRequestIdentity,
} from "./turn-model-step.js";
import {
  executionModelSelectionIdentity,
  modelSelectionFromModel,
  readExecutionFailoverRetryYieldClaim,
} from "./model-failover-router.js";
import type {
  ExecutionFailoverPolicyPort,
  ExecutionFailoverPolicyTarget,
} from "./model-failover-policy.js";

const modelA = {
  modelId: "model-a",
  options: {},
  providerId: "provider-a",
} as Model;
const modelB = {
  modelId: "model-b",
  options: {},
  providerId: "provider-b",
} as Model;
const baseMessages = [{ content: "continue", role: "user" as const }];
const baseTools: ModelToolContract[] = [
  { inputSchema: { type: "object" }, name: "Read", readOnly: true },
];

function requestIdentity(messages = baseMessages, tools: ModelToolContract[] = baseTools): string {
  return createModelRetryRequestIdentity({
    maxOutputTokens: 1024,
    messages,
    model: modelA,
    tools,
  });
}

function stateWithContinuation(identity: string): RegularTurnLoopState {
  return {
    pendingModelRetryContinuation: {
      consumedRetryAttempts: 1,
      requestIdentity: identity,
      selectionIdentity: executionModelSelectionIdentity(modelSelectionFromModel(modelA)),
    },
  } as RegularTurnLoopState;
}

test("retry continuation is consumed once only for the same selection and request", () => {
  const identity = requestIdentity();
  const state = stateWithContinuation(identity);

  assert.equal(
    consumePendingModelRetryContinuation(state, { model: modelA, requestIdentity: identity }),
    1,
  );
  assert.equal(state.pendingModelRetryContinuation, undefined);
  assert.equal(
    consumePendingModelRetryContinuation(state, { model: modelA, requestIdentity: identity }),
    undefined,
  );
});

test("retry continuation is discarded when provider messages change", () => {
  const state = stateWithContinuation(requestIdentity());
  const changedIdentity = requestIdentity([{ content: "steered", role: "user" }]);

  assert.equal(
    consumePendingModelRetryContinuation(state, {
      model: modelA,
      requestIdentity: changedIdentity,
    }),
    undefined,
  );
  assert.equal(state.pendingModelRetryContinuation, undefined);
});

test("retry continuation is discarded when tool contract or selection changes", () => {
  const identity = requestIdentity();
  const changedToolIdentity = requestIdentity(baseMessages, [
    { inputSchema: { type: "object" }, name: "Write", readOnly: false },
  ]);
  const toolChangedState = stateWithContinuation(identity);
  assert.equal(
    consumePendingModelRetryContinuation(toolChangedState, {
      model: modelA,
      requestIdentity: changedToolIdentity,
    }),
    undefined,
  );

  const selectionChangedState = stateWithContinuation(identity);
  assert.equal(
    consumePendingModelRetryContinuation(selectionChangedState, {
      model: modelB,
      requestIdentity: identity,
    }),
    undefined,
  );
});

test("malformed retry-yield claims cannot create a continuation", () => {
  assert.equal(
    readExecutionFailoverRetryYieldClaim({ context: { retryYieldedToFailover: true } }),
    undefined,
  );
  assert.equal(
    readExecutionFailoverRetryYieldClaim({
      context: {
        retryYieldConsumedRetryAttempts: -1,
        retryYieldedToFailover: true,
      },
    }),
    undefined,
  );
  assert.deepEqual(
    readExecutionFailoverRetryYieldClaim({
      context: {
        retryYieldConsumedRetryAttempts: 1,
        retryYieldPolicyRevision: 2,
        retryYieldSourceCommandId: "command-b",
        retryYieldedToFailover: true,
      },
    }),
    {
      consumedRetryAttempts: 1,
      policyRevision: 2,
      sourceCommandId: "command-b",
    },
  );
});

test("retry-yield recovery closes a failed model step only once after activation is superseded", async () => {
  const modelB = createCompatibleModel("provider-b", "model-b");
  const targetB = {
    id: "foreground-1",
    kind: "foregroundExecution",
    modelSelection: { modelId: modelB.modelId, providerId: modelB.providerId },
    revision: 1,
    sourceCommandId: "command-b",
    status: "waitingSafeBoundary",
  } satisfies ExecutionFailoverPolicyTarget;
  const targetC = {
    ...targetB,
    modelSelection: { modelId: "model-c", providerId: "provider-c" },
    revision: 2,
    sourceCommandId: "command-c",
    status: "blocked",
  } satisfies ExecutionFailoverPolicyTarget;
  let target: ExecutionFailoverPolicyTarget = targetB;
  const policyPort = {
    activate: async (input: Parameters<ExecutionFailoverPolicyPort["activate"]>[0]) => {
      await input.beforeActivate?.();
      target = targetC;
      return false;
    },
    resolve: () => target,
    settle: async () => undefined,
  } as unknown as ExecutionFailoverPolicyPort;
  const persistedAssistantMessages: unknown[][] = [];
  const runtime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: policyPort,
    executionFailoverScope: { foregroundExecutionId: "foreground-1" },
    executionFailoverScopeLifetime: "turn",
    failoverModelFactory: () => modelB,
    persistAssistantMessage: async (...args: unknown[]) => {
      persistedAssistantMessages.push(args);
    },
    rootTraceContext: {} as TraceContext,
  } as unknown as AgentRuntimeInternal;
  const state = createModelStepState();
  const assistantMessageId = "assistant-1" as MessageId;

  const activation = await closeFailedModelStepAndActivateFailover.call(runtime, state, {
    assistantCreatedAt: 1,
    assistantMessageId,
    model: state.model,
    modelTraceContext: state.turnTraceContext,
    reasonCode: "network.transport_unavailable",
  });
  assert.deepEqual(activation, { activated: false, failedStepClosed: true });

  await closeRetryYieldRecoveryStepIfNeeded.call(runtime, state, {
    assistantCreatedAt: 1,
    assistantMessageId,
    failedStepClosed: activation.failedStepClosed,
    model: state.model,
    modelTraceContext: state.turnTraceContext,
  });

  assert.equal(state.modelResponse, "");
  assert.equal(state.modelStepCount, 1);
  assert.equal(state.historyRoundCount, 1);
  assert.equal(persistedAssistantMessages.length, 1);
});

function createCompatibleModel(providerId: string, modelId: string): Model {
  return {
    modelId,
    options: {},
    properties: {
      contextWindow: 128_000,
      inputFormat: {
        supportsAudio: true,
        supportsImage: true,
        supportsPdf: true,
        supportsText: true,
        supportsVideo: true,
      },
      outputFormat: { supportsText: true },
      requiresMfjsToolSchema: false,
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: true,
      supportsNativeWebSearch: false,
      supportsToolCall: true,
    },
    providerId,
  } as Model;
}

function createModelStepState(): RegularTurnLoopState {
  const model = createCompatibleModel("provider-a", "model-a");
  let turnMachine = TurnMachineImpl.create(
    "session-1" as SessionId,
    1,
    "prompt",
    "trace-1" as TraceId,
    "turn-1" as TurnId,
  );
  turnMachine = new TurnMachineImpl(turnMachine.start());
  turnMachine = new TurnMachineImpl(turnMachine.startModelRequest(model.modelId, []));
  return {
    currentUserMessageId: "user-1" as MessageId,
    events: [],
    executionFailoverTransitionCount: 0,
    executionFailoverUnsafePolicies: new Set(),
    executionFailoverVisitedModels: new Set([
      executionModelSelectionIdentity(modelSelectionFromModel(model)),
    ]),
    historyRoundCount: 0,
    model,
    modelResponse: "partial",
    modelStepCount: 0,
    turnAbortSignal: new AbortController().signal,
    turnMachine,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
    turnTraceContext: {} as TraceContext,
  } as RegularTurnLoopState;
}
