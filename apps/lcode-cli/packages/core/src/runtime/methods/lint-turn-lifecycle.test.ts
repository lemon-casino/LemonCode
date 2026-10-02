import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  CoreErrorType,
  createQueryId,
  createTurnId,
  SessionEventType,
  TurnMachineImpl,
} from "../deps.js";
import type { ModelStreamEvent, SessionEvent, TraceContext } from "../deps.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { executeTurnCommand } from "./turn.js";
import { completeHookBlockedTurn } from "./turn-outcomes.js";
import { completeRegularTurn } from "./turn-complete.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

test("regular turn uses the admitted mock model and releases its abort/start ownership", async () => {
  const { runtime, storedEvents } = createMockRuntime();
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  const result = await executeTurnCommand.call(runtime, "mock query", undefined, {
    abortSignal: controller.signal,
  });
  assert.equal(result.response, "Mock result");
  assert.equal(result.events.at(-1)?.type, SessionEventType.TurnComplete);
  assert.equal(
    storedEvents.filter((event) => event.type === SessionEventType.ModelRequest).length,
    1,
  );
  assert.equal(runtime.activeTurn, undefined);
  assert.equal(runtime.activeTurnStartReservation, undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
});

test("cancelled mock stream persists its partial text and releases abort ownership", async () => {
  const controller = new AbortController();
  const { runtime, storedEvents } = createMockRuntime({}, async function* () {
    yield { type: "text_start", id: "partial" } satisfies ModelStreamEvent;
    yield { type: "text_delta", id: "partial", text: "partial answer" } satisfies ModelStreamEvent;
    controller.abort(new Error("test cancellation"));
    throw controller.signal.reason;
  });
  await assert.rejects(
    executeTurnCommand.call(runtime, "cancelled mock query", undefined, {
      abortSignal: controller.signal,
    }),
    (error: unknown) => (error as { type?: string }).type === CoreErrorType.TurnCancelled,
  );
  assert.ok(storedEvents.some((event) => event.type === SessionEventType.TurnComplete));
  assert.ok(!storedEvents.some((event) => event.type === SessionEventType.TurnError));
  assert.match(
    JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries()),
    /partial answer/,
  );
  assert.equal(runtime.activeTurn, undefined);
  assert.equal(runtime.activeTurnStartReservation, undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("hook completion updates the same turn machine before a falsy persistence failure", async () => {
  const { runtime } = createMockRuntime();
  const turnId = createTurnId();
  const trace = { ...runtime.rootTraceContext, turnId };
  let machine = TurnMachineImpl.create(runtime.sessionId, 0, "blocked", trace.traceId, turnId);
  machine = new TurnMachineImpl(machine.start());
  const activeTurn = runtime.beginActiveTurn(turnId, trace, "regular", true);
  const order: string[] = [];
  runtime.appendEvent = async () => {
    order.push("persist");
    assert.equal(machine.isComplete(), true);
    throw false;
  };
  await assert.rejects(
    completeHookBlockedTurn.call(
      runtime,
      {
        activeTurn,
        events: [],
        options: undefined,
        startedTarget: null,
        targetRunInputID: String(turnId),
        traceId: trace.traceId,
        turnId,
        turnMachine: machine,
        turnStartedAtMs: 1,
        turnTraceContext: trace,
        userPromptHookResult: { additionalContexts: [], preventContinuation: true },
      },
      (next) => {
        machine = next;
        order.push("state");
      },
    ),
    (error) => error === false,
  );
  assert.deepEqual(order, ["state", "persist"]);
  assert.equal(activeTurn.steerable, false);
});

test("turn completion keeps admission trace when inline guide advances the model query", async () => {
  const { runtime } = createMockRuntime();
  const turnId = createTurnId();
  const admissionTrace = { ...runtime.rootTraceContext, queryId: createQueryId(), turnId };
  const guidedTrace = { ...admissionTrace, queryId: createQueryId() };
  const observed: TraceContext[] = [];
  runtime.accountTargetTurnCompletion = async (input) => {
    observed.push(input.traceContext);
  };
  runtime.appendEvent = async (_event: SessionEvent, trace: TraceContext) => {
    observed.push(trace);
  };
  const machine = new TurnMachineImpl(
    TurnMachineImpl.create(runtime.sessionId, 0, "query", admissionTrace.traceId, turnId).start(),
  );
  const state = {
    events: [],
    historyRoundCount: 1,
    modelResponse: "done",
    tokenCount: 2,
    toolCallCount: 0,
    traceId: admissionTrace.traceId,
    turnId,
    turnMachine: machine,
    turnTraceContext: guidedTrace,
  } as unknown as RegularTurnLoopState;
  await completeRegularTurn.call(runtime, state, {
    displayInput: "query",
    options: { modelExecution: { selectionScope: "execution", memoryExtraction: "skip" } },
    shouldRetryTitleGenerationAfterTurn: false,
    startedTarget: null,
    targetRunInputID: String(turnId),
    turnStartedAtMs: 1,
    turnTraceContext: admissionTrace,
  });
  assert.deepEqual(observed, [admissionTrace, admissionTrace]);
  assert.equal(state.turnTraceContext, guidedTrace);
});
