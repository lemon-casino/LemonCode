import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelSelection, TraceContext } from "@lcode/contracts";
import { TurnMachineImpl } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { createExecutionFailoverPolicyPort } from "./model-failover-policy.js";
import {
  executionModelSelectionIdentity,
  modelSelectionFromModel,
  activateExecutionFailoverAtSafeBoundary,
} from "./model-failover-router.js";
import { createModelSwitchRequest } from "./model-switch-request.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { setTimeout as delay } from "node:timers/promises";
import { isTurnCancellationError } from "../helpers/index.js";

const traceContext = {} as TraceContext;
const a: ModelSelection = { providerId: "provider-a", modelId: "model-a" };
const b: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "max", speed: "fast" },
};
const c: ModelSelection = { providerId: "provider-c", modelId: "model-c" };
function model(selection: ModelSelection): Model {
  return {
    ...selection,
    options: selection.options ?? {},
    optionSpecs: { maxOutputTokens: { max: 1024 } },
    properties: {
      contextWindow: 200_000,
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
      requiresMfjsToolSchema: false,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
    },
  } as Model;
}

function stepFixture(partial = false, ignoresAbort = false) {
  const f = fixture();
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const scope = {
    run: <T>(work: () => T) => work(),
    finishCompleted: () => undefined,
    finishFailed: () => undefined,
    finishCancelled: () => undefined,
  };
  Object.assign(f.runtime, {
    agentTelemetry: { step: () => scope },
    logModelRequestSteeringContext: () => undefined,
    persistAssistantMessage: async () => undefined,
    persistPart: async () => undefined,
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
    registry: { get: () => undefined },
    runModelTextRequest: async (input: {
      abortSignal: AbortSignal;
      onStreamTextDelta: (text: string) => void;
    }) => {
      if (partial) input.onStreamTextDelta("partial");
      started();
      if (ignoresAbort) {
        await new Promise<void>((resolve) =>
          input.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { text: "late old-model result", toolCalls: [] };
      }
      await delay(60_000, undefined, { signal: input.abortSignal });
    },
  });
  const start = () =>
    runModelBackedTurnStep.call(f.runtime, f.state, {
      messages: [],
      recordedMessages: [],
      sourceEntries: [],
      requestEntries: [],
      tools: [],
    });
  return { ...f, start, beginning };
}
function fixture() {
  const abort = new AbortController();
  const runtime = {
    sessionId: "switch-session",
    config: { taskType: "interactive" },
    now: () => new Date(1_000),
    activeForegroundExecution: {
      foregroundExecutionId: "foreground",
      controller: new AbortController(),
      disposeParentAbort: () => undefined,
      preserveQueueAutoDrainOnCancel: false,
      currentModelSelection: a,
    },
    executionFailoverMutation: Promise.resolve(),
    executionFailoverRevision: 0,
    executionFailoverRegistrations: new Map(),
    executionFailoverDormantIntents: new Map(),
    executionFailoverLineageLeases: new Map(),
    runtimeTaskRegistry: { get: () => undefined },
    appendEvent: async () => undefined,
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) => model(selection),
  } as unknown as AgentRuntimeInternal;
  const port = createExecutionFailoverPolicyPort(runtime);
  runtime.executionFailoverPolicyPort = port;
  let machine = TurnMachineImpl.create(
    "switch-session" as never,
    1,
    "input",
    "trace" as never,
    "turn" as never,
  );
  machine = new TurnMachineImpl(machine.start());
  machine = new TurnMachineImpl(machine.startModelRequest(a.modelId, []));
  const state = {
    model: model(a),
    events: [],
    currentUserMessageId: "user",
    toolCallCount: 0,
    modelStepCount: 0,
    modelResponse: "",
    historyRoundCount: 0,
    turnAbortSignal: abort.signal,
    turnMachine: machine,
    turnTraceContext: traceContext,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
    executionFailoverTransitionCount: 0,
    executionFailoverUnsafePolicies: new Set(),
    executionFailoverVisitedModels: new Set([executionModelSelectionIdentity(a)]),
  } as unknown as RegularTurnLoopState;
  const select = (selection = b, id = "switch-b") =>
    port.setTarget({
      modelSelection: selection,
      observedTargets: { foregroundExecutionId: "foreground", backgroundWorkIds: [] },
      sourceCommandId: id,
      traceContext,
    });
  return { runtime, port, state, abort, select };
}

test("immediate switching cancels only the request after the target is durably accepted", async () => {
  const f = fixture();
  const request = createModelSwitchRequest(f.runtime, f.state);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.runtime.appendEvent = async () => gate;
  const accepted = f.select();
  await Promise.resolve();
  assert.equal(request.signal.aborted, false);
  release();
  await accepted;
  assert.equal(request.signal.aborted, true);
  assert.equal(request.interrupted, true);
  assert.equal(f.abort.signal.aborted, false);
  assert.equal(f.runtime.activeForegroundExecution?.controller.signal.aborted, false);
  request.close();
});

test("an unavailable or incompatible target leaves the old request running", async () => {
  for (const unavailable of [true, false]) {
    const f = fixture();
    f.runtime.failoverModelFactory = () => {
      if (unavailable) throw new Error("unavailable");
      const target = model(b);
      target.properties.contextWindow = 1;
      return target;
    };
    const request = createModelSwitchRequest(f.runtime, f.state);
    await f.select();
    assert.equal(request.signal.aborted, false);
    request.close();
  }
});

test("Stop takes precedence over switching and closed requests no longer observe targets", async () => {
  const stopped = fixture();
  const request = createModelSwitchRequest(stopped.runtime, stopped.state);
  stopped.abort.abort(new Error("user stopped"));
  await stopped.select();
  assert.equal(request.signal.aborted, true);
  assert.equal(request.interrupted, false);
  request.close();
  const finished = fixture();
  const old = createModelSwitchRequest(finished.runtime, finished.state);
  old.close();
  await finished.select();
  assert.equal(old.signal.aborted, false);
});

test("shared policy notifications interrupt only the inherited child in the observed scope", async () => {
  const f = fixture();
  await f.port.retain({
    currentSelection: a,
    lifetime: "turn",
    scope: { foregroundExecutionId: "foreground", backgroundWorkId: "child" },
    traceContext,
  });
  const child = {
    ...f.runtime,
    executionFailoverScope: { foregroundExecutionId: "foreground", backgroundWorkId: "child" },
  } as AgentRuntimeInternal;
  const unrelated = {
    ...f.runtime,
    executionFailoverScope: { backgroundWorkId: "unrelated" },
  } as AgentRuntimeInternal;
  const childRequest = createModelSwitchRequest(child, f.state);
  const unrelatedRequest = createModelSwitchRequest(unrelated, f.state);
  await f.select();
  assert.equal(childRequest.interrupted, true);
  assert.equal(unrelatedRequest.interrupted, false);
  childRequest.close();
  unrelatedRequest.close();
});

for (const partial of [false, true]) {
  test(
    `a blocked network request switches within the same model step (partial=${partial})`,
    { timeout: 2_000 },
    async () => {
      const f = fixture();
      const owner = f.runtime.activeForegroundExecution;
      let started!: () => void;
      const beginning = new Promise<void>((resolve) => {
        started = resolve;
      });
      const scope = {
        run: <T>(work: () => T) => work(),
        finishCompleted: () => undefined,
        finishFailed: () => undefined,
        finishCancelled: () => undefined,
      };
      Object.assign(f.runtime, {
        agentTelemetry: { step: () => scope },
        logModelRequestSteeringContext: () => undefined,
        persistAssistantMessage: async () => undefined,
        persistPart: async () => undefined,
        messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
        registry: { get: () => undefined },
        runModelTextRequest: async (input: {
          abortSignal: AbortSignal;
          onStreamTextDelta: (text: string) => void;
        }) => {
          if (partial) input.onStreamTextDelta("partial");
          started();
          await new Promise((_resolve, reject) => {
            input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason), {
              once: true,
            });
          });
        },
      });
      const step = runModelBackedTurnStep.call(f.runtime, f.state, {
        messages: [],
        recordedMessages: [],
        sourceEntries: [],
        requestEntries: [],
        tools: [],
      });
      await beginning;
      await f.select();
      assert.equal(await step, "continue");
      assert.deepEqual(modelSelectionFromModel(f.state.model), b);
      assert.equal(f.state.turnAbortSignal.aborted, false);
      assert.equal(f.runtime.activeForegroundExecution, owner);
      assert.equal(f.state.modelStepCount, 1);
    },
  );
}

test(
  "rapid B to C selection during old-request recovery activates only the latest C",
  { timeout: 2_000 },
  async () => {
    const f = stepFixture();
    let release!: () => void;
    let recovering!: () => void;
    const recoveringStarted = new Promise<void>((resolve) => {
      recovering = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runtime.persistAssistantMessage = async (_id, _parent, _created, completion) => {
      if (completion?.finish === "provider_failover_discarded") {
        recovering();
        await gate;
      }
    };
    const step = f.start();
    await f.beginning;
    await f.select();
    await recoveringStarted;
    const latest = f.select(c, "switch-c");
    release();
    await latest;
    assert.equal(await step, "continue");
    assert.deepEqual(modelSelectionFromModel(f.state.model), c);
    assert.equal(f.runtime.executionFailoverState?.lastTransition?.to.providerId, c.providerId);
    assert.equal(f.state.executionFailoverTransitionCount, 1);
  },
);

test(
  "an old provider result arriving after abort cannot complete the task before switching",
  { timeout: 2_000 },
  async () => {
    const f = stepFixture(true, true);
    const step = f.start();
    await f.beginning;
    await f.select();
    assert.equal(await step, "continue");
    assert.deepEqual(modelSelectionFromModel(f.state.model), b);
    assert.equal(f.state.turnAbortSignal.aborted, false);
  },
);

test(
  "an incompatible replacement after abort resumes A from its checkpoint without cancelling the task",
  { timeout: 2_000 },
  async () => {
    const f = stepFixture();
    const initialFactory = f.runtime.failoverModelFactory!;
    f.runtime.failoverModelFactory = (input) => {
      const result = initialFactory(input);
      if (input.selection.providerId === c.providerId) result.properties.contextWindow = 1;
      return result;
    };
    let release!: () => void;
    let recovering!: () => void;
    const recoveringStarted = new Promise<void>((resolve) => {
      recovering = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runtime.persistAssistantMessage = async (_id, _parent, _created, completion) => {
      if (completion?.finish === "provider_failover_discarded") {
        recovering();
        await gate;
      }
    };
    const step = f.start();
    await f.beginning;
    await f.select();
    await recoveringStarted;
    const latest = f.select(c, "switch-c");
    release();
    await latest;
    assert.equal(await step, "continue");
    assert.deepEqual(modelSelectionFromModel(f.state.model), a);
    assert.equal(f.state.turnAbortSignal.aborted, false);
    assert.equal(f.state.modelStepCount, 1);
    assert.equal(f.port.resolve({ foregroundExecutionId: "foreground" })?.status, "blocked");
  },
);

for (const stopAt of ["recovery", "activation-append"] as const) {
  test(
    `Stop during ${stopAt} wins over an already cancelled model request`,
    { timeout: 2_000 },
    async () => {
      const f = stepFixture();
      const stop = new Error("user stopped");
      if (stopAt === "recovery") {
        f.runtime.persistAssistantMessage = async (_id, _parent, _created, completion) => {
          if (completion?.finish === "provider_failover_discarded") f.abort.abort(stop);
        };
      } else {
        f.runtime.appendEvent = async (event) => {
          if ((event.payload as { state?: { lastTransition?: unknown } }).state?.lastTransition)
            f.abort.abort(stop);
        };
      }
      const step = f.start();
      const outcome = assert.rejects(step, (error: unknown) =>
        isTurnCancellationError(error, f.abort.signal),
      );
      await f.beginning;
      await f.select();
      await outcome;
      assert.deepEqual(modelSelectionFromModel(f.state.model), a);
      assert.equal(f.state.executionFailoverTransitionCount, 0);
    },
  );
}

test(
  "manual switching to a visited model still interrupts immediately after automatic budget exhaustion",
  { timeout: 2_000 },
  async () => {
    const f = stepFixture();
    f.state.executionFailoverTransitionCount = 2;
    f.state.executionFailoverAutomaticTransitionCount = 2;
    f.state.executionFailoverVisitedModels.add(executionModelSelectionIdentity(b));
    const step = f.start();
    await f.beginning;
    await f.select();
    assert.equal(await step, "continue");
    assert.deepEqual(modelSelectionFromModel(f.state.model), b);
    assert.equal(f.state.executionFailoverTransitionCount, 3);
    assert.equal(f.state.executionFailoverAutomaticTransitionCount, 2);
  },
);

test("manual A to B to A to C switches preserve the same execution and do not consume the automatic budget", async () => {
  const f = fixture();
  const owner = f.runtime.activeForegroundExecution;
  for (const [index, selection] of [b, a, c, b].entries()) {
    const request = createModelSwitchRequest(f.runtime, f.state);
    await f.select(selection, `manual-${index}`);
    assert.equal(request.interrupted, true);
    request.close();
    assert.equal(await activateExecutionFailoverAtSafeBoundary(f.runtime, f.state), "activated");
    assert.deepEqual(modelSelectionFromModel(f.state.model), selection);
    assert.equal(f.runtime.activeForegroundExecution, owner);
  }
  assert.equal(f.state.executionFailoverTransitionCount, 4);
  assert.equal(f.state.executionFailoverAutomaticTransitionCount, 0);
});

test("automatic handoffs remain limited to two across intervening manual switches", async () => {
  const f = fixture();
  const d = { providerId: "provider-d", modelId: "model-d" };
  const e = { providerId: "provider-e", modelId: "model-e" };
  const choices = [
    { selection: b, reason: "userRequested" as const, automatic: 0 },
    { selection: c, reason: "provider.rate_limited" as const, automatic: 1 },
    { selection: a, reason: "userRequested" as const, automatic: 1 },
    { selection: d, reason: "provider.rate_limited" as const, automatic: 2 },
  ];
  for (const [index, choice] of choices.entries()) {
    await f.select(choice.selection, `choice-${index}`);
    assert.equal(
      await activateExecutionFailoverAtSafeBoundary(f.runtime, f.state, {
        reasonCode: choice.reason,
      }),
      "activated",
    );
    assert.equal(f.state.executionFailoverAutomaticTransitionCount, choice.automatic);
  }
  await f.select(e, "automatic-exhausted");
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(f.runtime, f.state, {
      reasonCode: "provider.rate_limited",
    }),
    "none",
  );
  assert.deepEqual(modelSelectionFromModel(f.state.model), d);
  assert.equal(f.state.executionFailoverAutomaticTransitionCount, 2);
  await f.select(e, "manual-despite-exhaustion");
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(f.runtime, f.state, {
      reasonCode: "userRequested",
    }),
    "activated",
  );
  assert.deepEqual(modelSelectionFromModel(f.state.model), e);
  assert.equal(f.state.executionFailoverAutomaticTransitionCount, 2);
});
