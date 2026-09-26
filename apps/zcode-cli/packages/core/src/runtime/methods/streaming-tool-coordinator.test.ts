import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageId,
  Model,
  ModelToolCall,
  SessionEvent,
  SessionId,
  TraceContext,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { TurnMachineImpl } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

const assistantMessageId = "assistant-1" as MessageId;
const traceContext = {} as TraceContext;
const model = {
  modelId: "model-a",
  options: {},
  providerId: "provider-a",
} as Model;

function createLoopState(streamRecoveryRetryCount = 0): RegularTurnLoopState {
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
    historyRoundCount: 0,
    modelResponse: "partial",
    modelStepCount: 0,
    streamRecoveryRetryCount,
    turnAbortSignal: new AbortController().signal,
    turnMachine,
  } as RegularTurnLoopState;
}

function createRuntimeFixture(): {
  appendedEvents: SessionEvent[];
  persistedAssistantMessages: unknown[][];
  runtime: AgentRuntimeInternal;
} {
  const appendedEvents: SessionEvent[] = [];
  const persistedAssistantMessages: unknown[][] = [];
  const runtime = {
    appendEvent: async (event: SessionEvent) => {
      appendedEvents.push(event);
    },
    createEvent: (type: SessionEvent["type"], payload: unknown) =>
      ({ payload, type }) as SessionEvent,
    persistAssistantMessage: async (...args: unknown[]) => {
      persistedAssistantMessages.push(args);
    },
    registry: {
      get: () => undefined,
      getMetadata: () => undefined,
    },
  } as unknown as AgentRuntimeInternal;
  return { appendedEvents, persistedAssistantMessages, runtime };
}

function createCoordinator(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  return createStreamingToolCoordinator(runtime, state, {
    assistantMessageId,
    model,
    traceContext,
  });
}

const nonRetryableFailure = {
  context: { reason: "invalid_request", retryable: false },
  message: "invalid request",
};

test("provider-executed tools fence non-retryable partial output from failover recovery", async () => {
  const { persistedAssistantMessages, runtime } = createRuntimeFixture();
  const state = createLoopState();
  const coordinator = createCoordinator(runtime, state);
  coordinator.recordTextDelta("partial response");
  coordinator.accept({
    id: "provider-tool-1",
    input: { query: "status" },
    name: "provider_tool",
    providerExecuted: true,
  });

  const recovery = await coordinator.recoverFromModelFailure(nonRetryableFailure, 1_000, {
    allowProviderFailover: true,
  });

  assert.deepEqual(recovery, {
    failoverSafe: false,
    providerFailoverOverrideUsed: false,
    recovered: false,
  });
  assert.equal(state.streamRecoveryRetryCount, 0);
  assert.equal(persistedAssistantMessages.length, 0);
});

test("eligible failover override recovers partial text when no tool was observed", async () => {
  const { appendedEvents, persistedAssistantMessages, runtime } = createRuntimeFixture();
  const state = createLoopState();
  const coordinator = createCoordinator(runtime, state);
  coordinator.recordTextDelta("partial response");

  const recovery = await coordinator.recoverFromModelFailure(nonRetryableFailure, 1_000, {
    allowProviderFailover: true,
    failedRequestId: "request-a",
  });

  assert.deepEqual(recovery, {
    failoverSafe: true,
    providerFailoverOverrideUsed: true,
    recovered: true,
  });
  assert.equal(state.streamRecoveryRetryCount, 1);
  assert.equal(state.modelResponse, "");
  assert.equal(persistedAssistantMessages.length, 1);
  assert.equal(appendedEvents.length, 4);
});

test("exhausted recovery budget is failover-unsafe while a tool handle is unresolved", async () => {
  let releasePendingPersist: (() => void) | undefined;
  const pendingPersist = new Promise<void>((resolve) => {
    releasePendingPersist = resolve;
  });
  const { runtime } = createRuntimeFixture();
  Object.assign(runtime, {
    config: { modelStreaming: "on", streamingToolExecution: "on" },
    emitToolScheduledEvents: async () => [],
    executeTools: async () => ({ events: [], results: [] }),
    persistPart: () => pendingPersist,
    registry: {
      get: () => ({
        metadata: {
          concurrentSafe: true,
          destructive: false,
          needsApproval: false,
          readOnly: true,
          sideEffectScope: "none",
        },
      }),
      getMetadata: () => undefined,
    },
    scheduleTools: async () => ({}),
  });
  const state = createLoopState(10);
  const coordinator = createCoordinator(runtime, state);
  const toolCall: ModelToolCall = {
    id: "local-tool-1",
    input: {},
    name: "read_only_tool",
  };
  coordinator.accept(toolCall);

  const recovery = await coordinator.recoverFromModelFailure(nonRetryableFailure, 1_000, {
    allowProviderFailover: true,
  });

  assert.deepEqual(recovery, {
    failoverSafe: false,
    providerFailoverOverrideUsed: false,
    recovered: false,
  });
  releasePendingPersist?.();
  await coordinator.drain([toolCall]);
});
