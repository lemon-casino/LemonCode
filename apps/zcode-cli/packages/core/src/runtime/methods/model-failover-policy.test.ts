import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentModelInvocationContext, ModelRetryBudget } from "@zcode/contracts";
import type {
  ExecutionFailoverChangedPayload,
  Model,
  ModelInvocationContext,
  ModelRequestAdmission,
  ModelRequestDependencies,
  ModelSelection,
  TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  executionFailoverStateSchema,
  MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS,
  MAX_EXECUTION_FAILOVER_TARGETS,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createExecutionFailoverPolicyPort,
  getExecutionFailoverLineageId,
  type ExecutionFailoverPolicyPort,
  type ExecutionFailoverPolicyTarget,
  type ExecutionFailoverScope,
} from "./model-failover-policy.js";
import {
  activateExecutionFailoverAtSafeBoundary,
  blockExecutionFailoverTargetForModelCreationFailure,
  canActivateExecutionFailoverAtSafeBoundary,
  classifyExecutionFailoverFailure,
  executionModelSelectionIdentity,
  hasExecutionFailoverTarget,
  markExecutionFailoverUnsafe,
  shouldYieldRetryToExecutionFailover,
} from "./model-failover-router.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { runRegularTurnLoop } from "./turn-loop.js";

const traceContext = {} as TraceContext;
const selectionA: ModelSelection = { providerId: "provider-a", modelId: "model-a" };
const selectionB: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high", speed: "fast" },
};
const selectionC: ModelSelection = { providerId: "provider-c", modelId: "model-c" };
const selectionBMedium: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "medium", speed: "fast" },
};

function createModel(selection: ModelSelection, contextWindow: number): Model {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: {
      reasoningLevel: selection.options?.reasoningLevel,
      speed: selection.options?.speed,
    },
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
  } as Model;
}

function assertSameModelSelection(actual: Model, expected: Model): void {
  assert.equal(actual.providerId, expected.providerId);
  assert.equal(actual.modelId, expected.modelId);
  assert.deepEqual(actual.options, expected.options);
}

function createLoopState(model: Model): RegularTurnLoopState {
  return {
    executionFailoverTransitionCount: 0,
    executionFailoverUnsafePolicies: new Set(),
    executionFailoverVisitedModels: new Set([
      executionModelSelectionIdentity({
        providerId: model.providerId,
        modelId: model.modelId,
        options: {
          reasoningLevel: model.options.reasoningLevel,
          speed: model.options.speed,
        },
      }),
    ]),
    model,
    turnAbortSignal: new AbortController().signal,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
    turnTraceContext: traceContext,
  } as RegularTurnLoopState;
}

function createPolicyRuntime(): {
  events: Array<Record<string, unknown>>;
  port: ExecutionFailoverPolicyPort;
  runtime: AgentRuntimeInternal;
} {
  const events: Array<Record<string, unknown>> = [];
  const runtime = {
    activeForegroundExecution: {
      controller: new AbortController(),
      currentModelSelection: selectionA,
      disposeParentAbort: () => undefined,
      foregroundExecutionId: "foreground-1",
      preserveQueueAutoDrainOnCancel: false,
    },
    appendEvent: async (event: Record<string, unknown>) => {
      const state = (event.payload as { state?: unknown }).state;
      if (state) executionFailoverStateSchema.parse(state);
      events.push(event);
    },
    createEvent: (type: string, payload: unknown) => ({ payload, type }),
    config: { taskType: "interactive" },
    executionFailoverMutation: Promise.resolve(),
    executionFailoverDormantIntents: new Map(),
    executionFailoverLineageLeases: new Map(),
    executionFailoverRegistrations: new Map(),
    executionFailoverRevision: 0,
    executionFailoverState: undefined,
    now: () => new Date(1_000),
    rootTraceContext: traceContext,
    runtimeTaskRegistry: {
      get: () => undefined,
    },
  } as unknown as AgentRuntimeInternal;
  const port = createExecutionFailoverPolicyPort(runtime);
  runtime.executionFailoverPolicyPort = port;
  return { events, port, runtime };
}

function latestFailoverPayload(
  events: Array<Record<string, unknown>>,
): ExecutionFailoverChangedPayload {
  const event = events[events.length - 1];
  assert.ok(event);
  return event.payload as ExecutionFailoverChangedPayload;
}

test("runtime registrations publish eligibility while turn registrations stay excluded", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const runtimeScope = {
    backgroundWorkId: "runtime-eligible-1",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const turnScope = {
    backgroundWorkId: "turn-private-1",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;

  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: runtimeScope,
    traceContext,
  });
  assert.equal(events.length, 0);

  await port.retain({
    currentSelection: selectionB,
    lifetime: "runtime",
    scope: runtimeScope,
    traceContext,
  });

  assert.equal(events.length, 1);
  assert.deepEqual(latestFailoverPayload(events), {
    cause: "eligibleTargetsChanged",
    eligibleBackgroundWorkIds: [runtimeScope.backgroundWorkId],
    revision: 1,
    state: null,
  });

  await port.retain({
    currentSelection: selectionC,
    lifetime: "turn",
    scope: runtimeScope,
    traceContext,
  });
  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: turnScope,
    traceContext,
  });

  assert.equal(events.length, 1);
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(runtimeScope.backgroundWorkId)?.currentSelection,
    selectionC,
  );
  assert.equal(
    runtime.executionFailoverRegistrations.get(runtimeScope.backgroundWorkId)?.lifetime,
    "runtime",
  );

  await port.release(runtimeScope, traceContext);

  assert.equal(events.length, 2);
  assert.deepEqual(latestFailoverPayload(events), {
    cause: "eligibleTargetsChanged",
    eligibleBackgroundWorkIds: [],
    revision: 2,
    state: null,
  });
  assert.equal(runtime.executionFailoverRegistrations.has(runtimeScope.backgroundWorkId), false);
  assert.equal(runtime.executionFailoverRegistrations.has(turnScope.backgroundWorkId), true);
});

test("eligibility-only changes clone an active policy with the same source command", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  let now = 1_000;
  runtime.now = () => new Date(now);
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-active-policy",
    traceContext,
  });
  const initialState = runtime.executionFailoverState;
  assert.ok(initialState);
  assert.deepEqual(latestFailoverPayload(events).eligibleBackgroundWorkIds, []);

  const actorScope = {
    backgroundWorkId: "runtime-active-policy",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  now = 2_000;
  await port.retain({
    currentSelection: selectionB,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });

  const retainedPayload = latestFailoverPayload(events);
  assert.equal(retainedPayload.cause, "eligibleTargetsChanged");
  assert.equal(retainedPayload.sourceCommandId, "command-active-policy");
  assert.deepEqual(retainedPayload.eligibleBackgroundWorkIds, [actorScope.backgroundWorkId]);
  assert.equal(retainedPayload.revision, initialState.revision + 1);
  assert.equal(retainedPayload.state?.revision, initialState.revision + 1);
  assert.equal(retainedPayload.state?.updatedAt, 2_000);
  assert.deepEqual(retainedPayload.state?.targets, initialState.targets);

  now = 3_000;
  await port.release(actorScope, traceContext);

  const releasedPayload = latestFailoverPayload(events);
  assert.equal(releasedPayload.cause, "eligibleTargetsChanged");
  assert.equal(releasedPayload.sourceCommandId, "command-active-policy");
  assert.deepEqual(releasedPayload.eligibleBackgroundWorkIds, []);
  assert.equal(releasedPayload.state?.revision, initialState.revision + 2);
  assert.equal(releasedPayload.state?.updatedAt, 3_000);
  assert.deepEqual(releasedPayload.state?.targets, initialState.targets);
});

test("runtime release removes eligibility and its policy target in one event", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "runtime-target-release",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-release-target",
    traceContext,
  });
  const eventCountBeforeRelease = events.length;

  await port.release(actorScope, traceContext);

  assert.equal(events.length, eventCountBeforeRelease + 1);
  assert.deepEqual(latestFailoverPayload(events), {
    cause: "targetsCompleted",
    eligibleBackgroundWorkIds: [],
    revision: 3,
    sourceCommandId: "command-release-target",
    state: null,
  });
  assert.equal(runtime.executionFailoverRegistrations.has(actorScope.backgroundWorkId), false);
  assert.equal(runtime.executionFailoverState, undefined);
});

test("eligibility membership commits only after the event append succeeds", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "runtime-append-retry",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const appendEvent = runtime.appendEvent;
  runtime.appendEvent = async () => {
    throw new Error("event append failed");
  };

  await assert.rejects(
    port.retain({
      currentSelection: selectionA,
      lifetime: "runtime",
      scope: actorScope,
      traceContext,
    }),
    /event append failed/,
  );
  assert.equal(runtime.executionFailoverRegistrations.has(actorScope.backgroundWorkId), false);
  assert.equal(runtime.executionFailoverRevision, 0);

  runtime.appendEvent = appendEvent;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  assert.deepEqual(latestFailoverPayload(events).eligibleBackgroundWorkIds, [
    actorScope.backgroundWorkId,
  ]);
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-append-retry",
    traceContext,
  });
  const stateBeforeFailedRelease = runtime.executionFailoverState;
  assert.ok(stateBeforeFailedRelease);

  runtime.appendEvent = async () => {
    throw new Error("event append failed");
  };
  await assert.rejects(port.release(actorScope, traceContext), /event append failed/);
  assert.equal(runtime.executionFailoverRegistrations.has(actorScope.backgroundWorkId), true);
  assert.equal(runtime.executionFailoverRevision, 2);
  assert.deepEqual(runtime.executionFailoverState, stateBeforeFailedRelease);

  runtime.appendEvent = appendEvent;
  await port.release(actorScope, traceContext);
  assert.equal(runtime.executionFailoverRegistrations.has(actorScope.backgroundWorkId), false);
  assert.deepEqual(latestFailoverPayload(events).eligibleBackgroundWorkIds, []);
  assert.equal(runtime.executionFailoverState, undefined);
});

test("eligibility projection reserves one slot per lineage before filling the cap", async () => {
  const { events, port } = createPolicyRuntime();
  for (let index = 0; index < 64; index += 1) {
    await port.retain({
      currentSelection: selectionA,
      lifetime: "runtime",
      scope: {
        backgroundWorkId: `lineage-a-${index}`,
        foregroundExecutionId: "lineage-a",
      },
      traceContext,
    });
  }
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: {
      backgroundWorkId: "lineage-b-0",
      foregroundExecutionId: "lineage-b",
    },
    traceContext,
  });

  const eligible = latestFailoverPayload(events).eligibleBackgroundWorkIds;
  assert.ok(eligible);
  assert.equal(eligible.length, 64);
  assert.deepEqual(eligible.slice(0, 2), ["lineage-a-0", "lineage-b-0"]);
  assert.equal(eligible.includes("lineage-a-63"), false);
});

test("same active selection completes without entering waitingSafeBoundary", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  assert.equal(
    await port.setTarget({
      modelSelection: selectionA,
      observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
      sourceCommandId: "command-same",
      traceContext,
    }),
    "applied",
  );
  assert.equal(runtime.executionFailoverState, undefined);
  assert.equal(events.length, 1);
  assert.equal((events[0]!.payload as { cause?: string }).cause, "targetsCompleted");
});

test("a target admitted during the initial empty microtask boundary activates immediately", async () => {
  const modelA = createModel(selectionA, 200_000);
  const modelB = createModel(selectionB, 200_000);
  const scope = { foregroundExecutionId: "foreground-microtask" } satisfies ExecutionFailoverScope;
  const waitingTarget = {
    id: scope.foregroundExecutionId,
    kind: "foregroundExecution",
    modelSelection: selectionB,
    revision: 1,
    sourceCommandId: "command-microtask-b",
    status: "waitingSafeBoundary",
  } satisfies ExecutionFailoverPolicyTarget;
  let visibleTarget: ExecutionFailoverPolicyTarget | undefined;
  let scheduleAdmission = true;
  let activationCount = 0;
  const policyPort = {
    activate: async (input: Parameters<ExecutionFailoverPolicyPort["activate"]>[0]) => {
      activationCount += 1;
      await input.beforeActivate?.();
      await input.prepare();
      input.commit();
      visibleTarget = {
        ...waitingTarget,
        currentSelection: selectionB,
        status: "active",
      };
      return true;
    },
    resolve: () => {
      if (scheduleAdmission) {
        scheduleAdmission = false;
        queueMicrotask(() => {
          visibleTarget = waitingTarget;
        });
      }
      return visibleTarget;
    },
    settle: async () => {
      await Promise.resolve();
    },
  } as ExecutionFailoverPolicyPort;
  const runtime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: policyPort,
    executionFailoverScope: scope,
    executionFailoverScopeLifetime: "turn",
    failoverModelFactory: () => modelB,
  } as unknown as AgentRuntimeInternal;
  const state = createLoopState(modelA);

  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, state), "activated");
  assertSameModelSelection(state.model, modelB);
  assert.equal(activationCount, 1);
});

test("foreground completion preserves lineage while a retained inherited actor remains", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-session-1",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b",
    traceContext,
  });

  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);

  const retainedState = runtime.executionFailoverState;
  assert.ok(retainedState);
  assert.equal(retainedState.foregroundExecutionId, "foreground-1");
  assert.deepEqual(
    retainedState.targets.map((target) => `${target.kind}:${target.id}`),
    ["backgroundWork:actor-session-1"],
  );
});

test("run lineage lease materializes a dormant target only when an inherited actor exists", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const lease = await port.acquireLineageLease("run-before-first-actor");
  assert.deepEqual(lease, {
    foregroundExecutionId: "foreground-1",
    leaseId: "run-before-first-actor",
  });

  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-before-first-actor",
    traceContext,
  });
  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);
  runtime.activeForegroundExecution = undefined;

  assert.equal(runtime.executionFailoverState, undefined);
  assert.deepEqual(latestFailoverPayload(events), {
    cause: "targetsCompleted",
    eligibleBackgroundWorkIds: [],
    revision: 2,
    sourceCommandId: "command-before-first-actor",
    state: null,
  });

  const actorScope = {
    backgroundWorkId: "actor-created-later",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });

  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionB);
  assert.deepEqual(runtime.executionFailoverState?.targets, [
    {
      currentSelection: selectionA,
      id: actorScope.backgroundWorkId,
      kind: "backgroundWork",
      status: "waitingSafeBoundary",
    },
  ]);
  const materialized = latestFailoverPayload(events);
  assert.deepEqual(materialized.eligibleBackgroundWorkIds, [actorScope.backgroundWorkId]);
  assert.equal(materialized.state?.targets.length, 1);
  assert.ok(!materialized.eligibleBackgroundWorkIds?.includes("run-before-first-actor"));
});

test("lineage intent survives one of multiple run leases and clears after the final release", async () => {
  const { port, runtime } = createPolicyRuntime();
  await port.acquireLineageLease("run-one");
  await port.acquireLineageLease("run-two");
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-multi-lease",
    traceContext,
  });
  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);
  runtime.activeForegroundExecution = undefined;

  await port.releaseLineageLease("run-one");
  const firstActor = {
    backgroundWorkId: "actor-after-first-release",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: firstActor,
    traceContext,
  });
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionB);
  await port.release(firstActor, traceContext);

  await port.releaseLineageLease("run-two");
  const actorAfterTerminal = {
    backgroundWorkId: "actor-after-final-release",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorAfterTerminal,
    traceContext,
  });
  assert.equal(runtime.executionFailoverState, undefined);
});

test("dormant actor materialization commits registration only after the combined event appends", async () => {
  const { port, runtime } = createPolicyRuntime();
  await port.acquireLineageLease("run-append-failure");
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-append-failure",
    traceContext,
  });
  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);
  runtime.activeForegroundExecution = undefined;
  runtime.appendEvent = async () => {
    throw new Error("event append unavailable");
  };
  const actorScope = {
    backgroundWorkId: "actor-append-failure",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;

  await assert.rejects(
    () =>
      port.retain({
        currentSelection: selectionA,
        lifetime: "runtime",
        scope: actorScope,
        traceContext,
      }),
    /event append unavailable/,
  );
  assert.equal(runtime.executionFailoverState, undefined);
  assert.equal(runtime.executionFailoverRegistrations.has(actorScope.backgroundWorkId), false);
});

test("policy reset clears run leases, dormant intents, registrations, and active state", async () => {
  const { port, runtime } = createPolicyRuntime();
  await port.acquireLineageLease("run-reset");
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: {
      backgroundWorkId: "actor-reset",
      foregroundExecutionId: "foreground-1",
    },
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-reset",
    traceContext,
  });

  await port.reset();

  assert.equal(runtime.executionFailoverState, undefined);
  assert.equal(runtime.executionFailoverRevision, 0);
  assert.equal(runtime.executionFailoverRegistrations.size, 0);
  assert.equal(runtime.executionFailoverLineageLeases.size, 0);
  assert.equal(runtime.executionFailoverDormantIntents.size, 0);
});

test("an observed retained actor remains switchable after its foreground completes", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "retained-actor-after-foreground",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-before-foreground-complete",
    traceContext,
  });
  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);
  runtime.activeForegroundExecution = undefined;

  assert.equal(
    await port.setTarget({
      modelSelection: selectionC,
      observedTargets: {
        backgroundWorkIds: [actorScope.backgroundWorkId],
      },
      sourceCommandId: "command-after-foreground-complete",
      traceContext,
    }),
    "applied",
  );
  assert.equal(runtime.executionFailoverState?.foregroundExecutionId, "foreground-1");
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.id, actorScope.backgroundWorkId);
  assert.equal(getExecutionFailoverLineageId.call(runtime), "foreground-1");
});

test("retained lineage registers later actors before the first switch", async () => {
  const { port, runtime } = createPolicyRuntime();
  const firstActorScope = {
    backgroundWorkId: "actor-before-foreground-complete",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: firstActorScope,
    traceContext,
  });
  runtime.activeForegroundExecution = undefined;
  const retainedLineage = getExecutionFailoverLineageId.call(runtime);
  assert.equal(retainedLineage, "foreground-1");
  const laterActorScope = {
    backgroundWorkId: "actor-after-foreground-complete",
    foregroundExecutionId: retainedLineage,
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: laterActorScope,
    traceContext,
  });

  assert.equal(
    await port.setTarget({
      modelSelection: selectionB,
      observedTargets: {
        backgroundWorkIds: [firstActorScope.backgroundWorkId],
      },
      sourceCommandId: "command-after-later-actor",
      traceContext,
    }),
    "applied",
  );
  assert.equal(runtime.executionFailoverState?.foregroundExecutionId, "foreground-1");
  assert.deepEqual(
    runtime.executionFailoverState?.targets.map((target) => target.id).sort(),
    [firstActorScope.backgroundWorkId, laterActorScope.backgroundWorkId].sort(),
  );
});

test("two children can activate from the same command despite unrelated revision progress", async () => {
  const { port, runtime } = createPolicyRuntime();
  const childOne = {
    backgroundWorkId: "child-1",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const childTwo = {
    backgroundWorkId: "child-2",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: childOne,
    traceContext,
  });
  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: childTwo,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-concurrent",
    traceContext,
  });
  const targetOne = port.resolve(childOne)!;
  const targetTwo = port.resolve(childTwo)!;

  assert.equal(
    await port.activate({
      attempt: 1,
      commit: () => undefined,
      from: selectionA,
      prepare: async () => undefined,
      reasonCode: "userRequested",
      scope: childOne,
      target: targetOne,
      traceContext,
    }),
    true,
  );
  assert.equal(
    await port.activate({
      attempt: 1,
      commit: () => undefined,
      from: selectionA,
      prepare: async () => undefined,
      reasonCode: "userRequested",
      scope: childTwo,
      target: targetTwo,
      traceContext,
    }),
    true,
  );
  assert.equal(
    runtime.executionFailoverState?.targets.find((target) => target.id === "child-1")?.status,
    "active",
  );
  assert.equal(
    runtime.executionFailoverState?.targets.find((target) => target.id === "child-2")?.status,
    "active",
  );
});

test("each scoped child applies the active target model at its own safe boundary", async () => {
  const { port } = createPolicyRuntime();
  const childOne = {
    backgroundWorkId: "runtime-child-1",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const childTwo = {
    backgroundWorkId: "runtime-child-2",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: childOne,
    traceContext,
  });
  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: childTwo,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-runtime-children",
    traceContext,
  });

  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const createChildRuntime = (scope: ExecutionFailoverScope) =>
    ({
      activeForegroundExecution: undefined,
      config: { taskType: "interactive" },
      contextBuilder: null,
      contextInitialized: false,
      executionFailoverPolicyPort: port,
      executionFailoverScope: scope,
      failoverModelFactory: () => modelB,
    }) as unknown as AgentRuntimeInternal;
  const stateOne = createLoopState(modelA);
  const stateTwo = createLoopState(modelA);

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(createChildRuntime(childOne), stateOne),
    "activated",
  );
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(createChildRuntime(childTwo), stateTwo),
    "activated",
  );
  assertSameModelSelection(stateOne.model, modelB);
  assertSameModelSelection(stateTwo.model, modelB);
});

test("an active foreground target is reapplied to later turns without a duplicate transition", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => modelB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-multi-turn",
    traceContext,
  });
  const firstTurn = createLoopState(modelA);
  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, firstTurn), "activated");
  const revisionAfterTransition = runtime.executionFailoverState?.revision;
  const eventCountAfterTransition = events.length;

  const laterTurn = createLoopState(modelA);
  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, laterTurn), "activated");
  assertSameModelSelection(laterTurn.model, modelB);
  assert.equal(runtime.executionFailoverState?.revision, revisionAfterTransition);
  assert.equal(events.length, eventCountAfterTransition);
});

test("active reapply does not apply an older target after a newer command is admitted", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const modelC = createModel(selectionC, 200_000);
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b-before-c",
    traceContext,
  });
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => modelB,
  });
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "activated",
  );

  let replacement: Promise<"applied" | "stale"> | undefined;
  runtime.failoverModelFactory = ({ selection }) => {
    if (selection.providerId === selectionB.providerId) {
      replacement = port.setTarget({
        modelSelection: selectionC,
        observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
        sourceCommandId: "command-c-latest",
        traceContext,
      });
      return modelB;
    }
    return modelC;
  };
  const laterTurn = createLoopState(modelA);
  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, laterTurn), "activated");
  await replacement;
  assertSameModelSelection(laterTurn.model, modelC);
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
});

test("a newer target queued inside activation wins the same safe boundary", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const modelC = createModel(selectionC, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) =>
      selection.providerId === selectionB.providerId ? modelB : modelC,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b-inside-activation",
    traceContext,
  });
  let beforeActivateCount = 0;
  let replacement: Promise<"applied" | "stale"> | undefined;
  const state = createLoopState(modelA);

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, state, {
      beforeActivate: async () => {
        beforeActivateCount += 1;
        replacement = port.setTarget({
          modelSelection: selectionC,
          observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
          sourceCommandId: "command-c-inside-activation",
          traceContext,
        });
      },
    }),
    "activated",
  );
  await replacement;
  assert.equal(beforeActivateCount, 1);
  assertSameModelSelection(state.model, modelC);
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "active");
});

test("a same-source eligibility mutation restabilizes the target in the same safe boundary", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => modelB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b-with-eligibility-change",
    traceContext,
  });
  const actorScope = {
    backgroundWorkId: "actor-retained-during-activation",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  let beforeActivateCount = 0;
  let retain: Promise<void> | undefined;
  const state = createLoopState(modelA);

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, state, {
      beforeActivate: async () => {
        beforeActivateCount += 1;
        retain = port.retain({
          currentSelection: selectionA,
          lifetime: "runtime",
          scope: actorScope,
          traceContext,
        });
      },
    }),
    "activated",
  );
  await retain;

  assert.equal(beforeActivateCount, 1);
  assertSameModelSelection(state.model, modelB);
  assert.equal(
    runtime.executionFailoverState?.sourceCommandId,
    "command-b-with-eligibility-change",
  );
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "active");
  assert.equal(runtime.executionFailoverRegistrations.has(actorScope.backgroundWorkId), true);
});

test("a same-source eligibility mutation restabilizes active-target reapplication", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => modelB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-active-b-with-eligibility-change",
    traceContext,
  });
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "activated",
  );
  const actorScope = {
    backgroundWorkId: "actor-retained-during-active-reapply",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  let beforeActivateCount = 0;
  let retain: Promise<void> | undefined;
  const nextTurn = createLoopState(modelA);

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, nextTurn, {
      beforeActivate: async () => {
        beforeActivateCount += 1;
        retain = port.retain({
          currentSelection: selectionA,
          lifetime: "runtime",
          scope: actorScope,
          traceContext,
        });
      },
    }),
    "activated",
  );
  await retain;

  assert.equal(beforeActivateCount, 1);
  assertSameModelSelection(nextTurn.model, modelB);
  assert.equal(
    runtime.executionFailoverState?.sourceCommandId,
    "command-active-b-with-eligibility-change",
  );
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "active");
});

test("an incompatible newer target discards an unrequested intermediate activation", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const incompatibleModelC = createModel(selectionC, 50_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) =>
      selection.providerId === selectionB.providerId ? modelB : incompatibleModelC,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b-before-incompatible-c",
    traceContext,
  });
  const eventCountBeforeBoundary = events.length;
  let beforeActivateCount = 0;
  let replacement: Promise<"applied" | "stale"> | undefined;
  const state = createLoopState(modelA);

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, state, {
      beforeActivate: async () => {
        beforeActivateCount += 1;
        replacement = port.setTarget({
          modelSelection: selectionC,
          observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
          sourceCommandId: "command-incompatible-c-latest",
          traceContext,
        });
      },
    }),
    "none",
  );
  await replacement;

  assert.equal(beforeActivateCount, 1);
  assertSameModelSelection(state.model, modelA);
  assert.equal(state.executionFailoverTransitionCount, 0);
  assert.deepEqual(
    state.executionFailoverVisitedModels,
    new Set([executionModelSelectionIdentity(selectionA)]),
  );
  assert.deepEqual(runtime.activeForegroundExecution?.currentModelSelection, selectionA);
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
  assert.equal(
    runtime.executionFailoverState?.targets[0]?.currentSelection?.providerId,
    selectionA.providerId,
  );
  assert.equal(
    events.slice(eventCountBeforeBoundary).some((event) => {
      const payload = event.payload as ExecutionFailoverChangedPayload;
      return payload.transition?.to.providerId === selectionB.providerId;
    }),
    false,
  );
});

test("a newer target admitted during transition persistence prevents the old model commit", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const incompatibleModelC = createModel(selectionC, 50_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) =>
      selection.providerId === selectionB.providerId ? modelB : incompatibleModelC,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b-before-transition-append",
    traceContext,
  });
  const appendEvent = runtime.appendEvent;
  let replacement: Promise<"applied" | "stale"> | undefined;
  runtime.appendEvent = async (event, eventTraceContext) => {
    const payload = event.payload as ExecutionFailoverChangedPayload;
    if (
      payload.cause === "safeBoundaryActivated" &&
      payload.transition?.to.providerId === selectionB.providerId &&
      replacement === undefined
    ) {
      replacement = port.setTarget({
        modelSelection: selectionC,
        observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
        sourceCommandId: "command-c-during-transition-append",
        traceContext,
      });
    }
    await appendEvent(event, eventTraceContext);
  };
  const state = createLoopState(modelA);

  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, state), "none");
  await replacement;

  assertSameModelSelection(state.model, modelA);
  assert.equal(state.executionFailoverTransitionCount, 0);
  assert.deepEqual(runtime.activeForegroundExecution?.currentModelSelection, selectionA);
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
  assert.deepEqual(
    events.map((event) => (event.payload as ExecutionFailoverChangedPayload).revision),
    [1, 2, 3, 4],
  );
});

test("active reapply marks an unavailable target blocked instead of retrying forever", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => modelB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-active-unavailable",
    traceContext,
  });
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "activated",
  );

  runtime.failoverModelFactory = () => {
    throw new Error("target removed");
  };
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "blocked",
  );
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
  assert.equal(runtime.executionFailoverState?.targets[0]?.reasonCode, "target.model_unavailable");
});

test("an incompatible waiting target is blocked while the current model remains active", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 200_000);
  const incompatibleB = createModel(selectionB, 100_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => incompatibleB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-waiting-incompatible",
    traceContext,
  });
  const state = createLoopState(modelA);

  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, state), "none");
  assert.equal(state.model, modelA);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
  assert.equal(
    runtime.executionFailoverState?.targets[0]?.reasonCode,
    "target.context_capacity_lower",
  );
});

test("a blocked active target fails the next turn before the old model can run", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverScopeLifetime: "turn",
    failoverModelFactory: () => modelB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-block-next-turn",
    traceContext,
  });
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "activated",
  );
  runtime.failoverModelFactory = () => {
    throw new Error("target removed");
  };

  await assert.rejects(
    () => runRegularTurnLoop.call(runtime, createLoopState(modelA)),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { context?: { code?: string } }).context?.code ===
        "execution_failover_target_blocked",
  );
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
});

test("reasoning option changes have distinct visited identity and yield old retries", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelBHigh = createModel(selectionB, 200_000);
  const modelBMedium = createModel(selectionBMedium, 200_000);
  runtime.activeForegroundExecution!.currentModelSelection = selectionB;
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverScopeLifetime: "turn",
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) => {
      assert.deepEqual(selection, selectionBMedium);
      return modelBMedium;
    },
  });
  await port.setTarget({
    modelSelection: selectionBMedium,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-reasoning-medium",
    traceContext,
  });
  const state = createLoopState(modelBHigh);
  assert.notEqual(
    executionModelSelectionIdentity(selectionB),
    executionModelSelectionIdentity(selectionBMedium),
  );

  assert.equal(
    (
      await shouldYieldRetryToExecutionFailover(runtime, state, modelBHigh, {
        attempt: 1,
        providerId: modelBHigh.providerId,
        modelId: modelBHigh.modelId,
        reason: "rate_limited",
        retryable: true,
        statusCode: 429,
      })
    ).shouldYield,
    true,
  );
  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, state), "activated");
  assertSameModelSelection(state.model, modelBMedium);
});

test("retry yield keeps the current provider when the failover target is incompatible", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 100_000);
  const retryFailure = {
    attempt: 1,
    providerId: modelA.providerId,
    modelId: modelA.modelId,
    reason: "rate_limited" as const,
    retryable: true,
    statusCode: 429,
  };
  const state = createLoopState(modelA);
  const imageEntry = {
    message: {
      role: "user",
      content: [
        {
          type: "image",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
    },
  } as RuntimeMessageEntry;

  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-incompatible-retry-target",
    traceContext,
  });

  const incompatibleTargets: ReadonlyArray<{
    entries?: readonly RuntimeMessageEntry[];
    model: Model;
  }> = [
    {
      model: {
        ...modelB,
        properties: { ...modelB.properties, supportsToolCall: false },
      },
    },
    { model: createModel(selectionB, 50_000) },
    {
      entries: [imageEntry],
      model: {
        ...modelB,
        properties: {
          ...modelB.properties,
          inputFormat: { ...modelB.properties.inputFormat, supportsImage: false },
        },
      },
    },
  ];

  for (const candidate of incompatibleTargets) {
    runtime.failoverModelFactory = () => candidate.model;
    assert.equal(
      (
        await shouldYieldRetryToExecutionFailover(
          runtime,
          state,
          modelA,
          retryFailure,
          candidate.entries ?? [],
        )
      ).shouldYield,
      false,
    );
  }

  runtime.failoverModelFactory = () => modelB;
  assert.equal(
    (await shouldYieldRetryToExecutionFailover(runtime, state, modelA, retryFailure)).shouldYield,
    true,
  );
});

test("retry yield uses the same unsafe, transition budget, and visited fences as a safe boundary", async () => {
  const retryFailure = {
    attempt: 1,
    providerId: selectionA.providerId,
    modelId: selectionA.modelId,
    reason: "rate_limited" as const,
    retryable: true,
    statusCode: 429,
  };

  for (const blockedBy of ["unsafe", "transition_budget", "visited"] as const) {
    const { port, runtime } = createPolicyRuntime();
    const modelA = createModel(selectionA, 100_000);
    const modelB = createModel(selectionB, 200_000);
    runtime.failoverModelFactory = () => modelB;
    await port.setTarget({
      modelSelection: selectionB,
      observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
      sourceCommandId: `command-${blockedBy}`,
      traceContext,
    });
    const state = createLoopState(modelA);
    if (blockedBy === "unsafe") markExecutionFailoverUnsafe(runtime, state);
    if (blockedBy === "transition_budget") state.executionFailoverTransitionCount = 2;
    if (blockedBy === "visited") {
      state.executionFailoverVisitedModels.add(executionModelSelectionIdentity(selectionB));
    }

    const decision = await shouldYieldRetryToExecutionFailover(
      runtime,
      state,
      modelA,
      retryFailure,
    );
    assert.equal(decision.shouldYield, false, blockedBy);
    assert.equal(canActivateExecutionFailoverAtSafeBoundary(runtime, state), false, blockedBy);
  }
});

test("retry yield is serialized behind an in-flight latest target append", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const incompatibleModelC = createModel(selectionC, 50_000);
  runtime.failoverModelFactory = ({ selection }) =>
    selection.providerId === selectionB.providerId ? modelB : incompatibleModelC;
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-b",
    traceContext,
  });

  const appendEvent = runtime.appendEvent;
  let appendStarted: (() => void) | undefined;
  const appendStartedPromise = new Promise<void>((resolve) => {
    appendStarted = resolve;
  });
  let releaseAppend: (() => void) | undefined;
  const appendBlocked = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  runtime.appendEvent = async (...args: Parameters<typeof appendEvent>) => {
    const event = args[0] as { payload?: { sourceCommandId?: string } };
    if (event.payload?.sourceCommandId === "command-c") {
      appendStarted?.();
      await appendBlocked;
    }
    await appendEvent(...args);
  };
  const replacement = port.setTarget({
    modelSelection: selectionC,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-c",
    traceContext,
  });
  await appendStartedPromise;

  let decisionSettled = false;
  const decisionPromise = shouldYieldRetryToExecutionFailover(
    runtime,
    createLoopState(modelA),
    modelA,
    {
      attempt: 1,
      providerId: modelA.providerId,
      modelId: modelA.modelId,
      reason: "rate_limited",
      retryable: true,
      statusCode: 429,
    },
  ).then((decision) => {
    decisionSettled = true;
    return decision;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(decisionSettled, false);

  releaseAppend?.();
  await replacement;
  const decision = await decisionPromise;
  assert.deepEqual(decision, {
    policyRevision: 2,
    shouldYield: false,
    sourceCommandId: "command-c",
  });
});

test("failover preflight stays side-effect free and activation preserves the full turn model pipeline", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  let invocationContext: ModelInvocationContext | undefined;
  let authResolveCount = 0;
  let headerRefreshCount = 0;
  const requestDependencies = {
    requestAuth: {
      source: {
        resolve: async () => {
          authResolveCount += 1;
          return { apiKey: "execution-token" };
        },
      },
    },
  } satisfies ModelRequestDependencies;
  const admission = {
    acquire: async () => ({ publish: () => undefined, release: () => undefined }),
  } satisfies ModelRequestAdmission;
  const factoryInputs: Array<{
    requestDependencies?: ModelRequestDependencies;
    selection: ModelSelection;
  }> = [];
  const rawTargetModel = {
    ...createModel(selectionB, 200_000),
    bind: () => rawTargetModel,
    generateText: async () => {
      invocationContext = getCurrentModelInvocationContext();
      await invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({
        attempt: 1,
        modelId: selectionB.modelId,
        providerId: selectionB.providerId,
      });
      await requestDependencies.requestAuth?.source?.resolve({
        attempt: 1,
        modelId: selectionB.modelId,
        providerId: selectionB.providerId,
      });
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as Model;
  Object.assign(runtime, {
    config: { taskType: "workflow_child" },
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: (input: {
      requestDependencies?: ModelRequestDependencies;
      selection: ModelSelection;
    }) => {
      factoryInputs.push(input);
      return rawTargetModel;
    },
    modelRequestAdmission: admission,
    providerRuntimeHeadersPort: {
      refreshBeforeModelRequest: async (input: { modelId: string; providerId: string }) => {
        headerRefreshCount += 1;
        assert.equal(input.providerId, selectionB.providerId);
        assert.equal(input.modelId, selectionB.modelId);
        return { headersApplied: true, requestAuth: { apiKey: "account-token" } };
      },
      shouldRefreshBeforeModelRequest: () => true,
    },
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-preserve-turn-model-pipeline",
    traceContext,
  });
  const state = createLoopState(modelA);
  state.modelRequestDependencies = requestDependencies;

  assert.equal(canActivateExecutionFailoverAtSafeBoundary(runtime, state), true);
  assert.equal(
    (
      await shouldYieldRetryToExecutionFailover(
        runtime,
        state,
        modelA,
        {
          attempt: 1,
          providerId: modelA.providerId,
          modelId: modelA.modelId,
          reason: "rate_limited",
          retryable: true,
          statusCode: 429,
        },
        [],
        requestDependencies,
      )
    ).shouldYield,
    true,
  );
  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, state), "activated");
  assert.equal(authResolveCount, 0);
  assert.equal(headerRefreshCount, 0);
  assert.ok(factoryInputs.length >= 3);
  for (const input of factoryInputs) {
    assert.deepEqual(input.selection, selectionB);
    assert.equal(input.requestDependencies, requestDependencies);
  }

  await state.model.generateText({ messages: [] });
  assert.equal(invocationContext?.modelRequestAdmission, admission);
  assert.equal(invocationContext?.modelRetryBudget, ModelRetryBudget.Unbounded);
  assert.equal(headerRefreshCount, 1);
  assert.equal(authResolveCount, 1);
  assert.equal(state.modelRequestDependencies, requestDependencies);
});

test("runtime-lifetime actor keeps active selection across asks and releases on close", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-runtime-lifetime",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  let actorSelection: ModelSelection = selectionA;
  const persistedSelections: ModelSelection[] = [];
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-runtime-actor",
    traceContext,
  });
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: (selection: ModelSelection) => {
      persistedSelections.push(selection);
    },
    failoverModelFactory: () => modelB,
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(actorRuntime, createLoopState(modelA)),
    "activated",
  );
  assert.deepEqual(actorSelection, selectionB);
  assert.deepEqual(persistedSelections, [selectionB]);
  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);
  const nextAsk = createLoopState(createModel(actorSelection, 200_000));
  assert.equal(await activateExecutionFailoverAtSafeBoundary(actorRuntime, nextAsk), "none");
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionB);

  await port.release(actorScope, traceContext);
  assert.equal(runtime.executionFailoverState, undefined);
});

test("runtime-lifetime activation retries after the journal sink rejects", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-retry-journal",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  let actorSelection: ModelSelection = selectionA;
  let sinkCalls = 0;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-actor-journal-retry",
    traceContext,
  });
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: () => {
      sinkCalls += 1;
      if (sinkCalls === 1) throw new Error("journal unavailable");
    },
    failoverModelFactory: () => modelB,
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;
  const firstState = createLoopState(modelA);

  await assert.rejects(
    () => activateExecutionFailoverAtSafeBoundary(actorRuntime, firstState),
    /journal unavailable/,
  );
  assert.equal(firstState.model, modelA);
  assert.deepEqual(actorSelection, selectionA);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "waitingSafeBoundary");
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(actorScope.backgroundWorkId)?.currentSelection,
    selectionA,
  );

  const retryState = createLoopState(modelA);
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(actorRuntime, retryState),
    "activated",
  );
  assert.equal(sinkCalls, 2);
  assertSameModelSelection(retryState.model, modelB);
  assert.deepEqual(actorSelection, selectionB);
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(actorScope.backgroundWorkId)?.currentSelection,
    selectionB,
  );
});

test("runtime-lifetime activation rolls journal back when the active event append fails", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-active-event-retry",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  let actorSelection: ModelSelection = selectionA;
  const persistedSelections: ModelSelection[] = [];
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-actor-active-event-retry",
    traceContext,
  });
  const appendEvent = runtime.appendEvent;
  let failActiveEventAppend = true;
  runtime.appendEvent = async (event, eventTraceContext) => {
    const payload = event.payload as ExecutionFailoverChangedPayload;
    if (failActiveEventAppend && payload.cause === "safeBoundaryActivated") {
      failActiveEventAppend = false;
      throw new Error("active event append unavailable");
    }
    await appendEvent(event, eventTraceContext);
  };
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: (selection: ModelSelection) => {
      persistedSelections.push(selection);
    },
    failoverModelFactory: () => modelB,
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;
  const firstState = createLoopState(modelA);

  await assert.rejects(
    () => activateExecutionFailoverAtSafeBoundary(actorRuntime, firstState),
    /active event append unavailable/,
  );
  assert.deepEqual(persistedSelections, [selectionB, selectionA]);
  assertSameModelSelection(firstState.model, modelA);
  assert.equal(firstState.executionFailoverTransitionCount, 0);
  assert.deepEqual(actorSelection, selectionA);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "waitingSafeBoundary");
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(actorScope.backgroundWorkId)?.currentSelection,
    selectionA,
  );

  const retryState = createLoopState(modelA);
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(actorRuntime, retryState),
    "activated",
  );
  assert.deepEqual(persistedSelections, [selectionB, selectionA, selectionB]);
  assertSameModelSelection(retryState.model, modelB);
  assert.deepEqual(actorSelection, selectionB);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "active");
});

test("activation prepares a throwable context refresh before durable selection commit", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-context-prepare-retry",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  let actorSelection: ModelSelection = selectionA;
  let sinkCalls = 0;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-context-prepare-retry",
    traceContext,
  });
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: {},
    contextInitialized: true,
    contextSourceSnapshot: {},
    createContextBuilderFromSnapshot: () => {
      throw new Error("context rebuild failed");
    },
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: () => {
      sinkCalls += 1;
    },
    failoverModelFactory: () => modelB,
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;
  const firstState = createLoopState(modelA);

  await assert.rejects(
    () => activateExecutionFailoverAtSafeBoundary(actorRuntime, firstState),
    /context rebuild failed/,
  );
  assert.equal(sinkCalls, 0);
  assert.equal(firstState.model, modelA);
  assert.deepEqual(actorSelection, selectionA);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "waitingSafeBoundary");

  actorRuntime.contextBuilder = null;
  actorRuntime.contextInitialized = false;
  const retryState = createLoopState(modelA);
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(actorRuntime, retryState),
    "activated",
  );
  assert.equal(sinkCalls, 1);
  assertSameModelSelection(retryState.model, modelB);
  assert.deepEqual(actorSelection, selectionB);
});

test("runtime-lifetime actor rolls a durable intermediate selection back for the latest target", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-atomic-selection",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 200_000);
  const modelB = createModel(selectionB, 200_000);
  let actorSelection: ModelSelection = selectionA;
  const persistedSelections: ModelSelection[] = [];
  let queuedSwitchBack: Promise<"applied" | "stale"> | undefined;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-actor-to-b",
    traceContext,
  });
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: (selection: ModelSelection) => {
      persistedSelections.push(selection);
      if (selection.providerId !== selectionB.providerId || queuedSwitchBack) return;
      // B 尚未完成原子提交时用户切回 A；journal 必须补偿回边界起点 A。
      queuedSwitchBack = port.complete(actorScope, traceContext).then(() =>
        port.setTarget({
          modelSelection: selectionA,
          observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
          sourceCommandId: "command-actor-back-to-a",
          traceContext,
        }),
      );
    },
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) =>
      selection.providerId === selectionB.providerId ? modelB : modelA,
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(actorRuntime, createLoopState(modelA)),
    "none",
  );
  assert.ok(queuedSwitchBack);
  assert.equal(await queuedSwitchBack, "applied");
  assert.deepEqual(persistedSelections, [selectionB, selectionA]);
  assert.deepEqual(actorSelection, selectionA);
  assert.equal(runtime.executionFailoverState, undefined);
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(actorScope.backgroundWorkId)?.currentSelection,
    selectionA,
  );
});

test("runtime-lifetime actor blocks incompatible latest target without leaking the staged model", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-latest-incompatible",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const incompatibleModelC = createModel(selectionC, 50_000);
  let actorSelection: ModelSelection = selectionA;
  const persistedSelections: ModelSelection[] = [];
  let replacement: Promise<"applied" | "stale"> | undefined;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-actor-staged-b",
    traceContext,
  });
  const eventCountBeforeBoundary = events.length;
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: (selection: ModelSelection) => {
      persistedSelections.push(selection);
      if (selection.providerId !== selectionB.providerId || replacement) return;
      replacement = port.setTarget({
        modelSelection: selectionC,
        observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
        sourceCommandId: "command-actor-incompatible-c",
        traceContext,
      });
    },
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) =>
      selection.providerId === selectionB.providerId ? modelB : incompatibleModelC,
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;
  const state = createLoopState(modelA);

  assert.equal(await activateExecutionFailoverAtSafeBoundary(actorRuntime, state), "none");
  await replacement;

  assert.deepEqual(persistedSelections, [selectionB, selectionA]);
  assertSameModelSelection(state.model, modelA);
  assert.equal(state.executionFailoverTransitionCount, 0);
  assert.deepEqual(actorSelection, selectionA);
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(actorScope.backgroundWorkId)?.currentSelection,
    selectionA,
  );
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
  assert.deepEqual(runtime.executionFailoverState?.targets[0]?.currentSelection, selectionA);
  assert.equal(
    events.slice(eventCountBeforeBoundary).some((event) => {
      const payload = event.payload as ExecutionFailoverChangedPayload;
      return payload.transition?.to.providerId === selectionB.providerId;
    }),
    false,
  );
});

test("runtime-lifetime actor fails closed when superseded journal compensation fails", async () => {
  const { port, runtime } = createPolicyRuntime();
  const actorScope = {
    backgroundWorkId: "actor-rollback-failure",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  let actorSelection: ModelSelection = selectionA;
  let persistedSelection: ModelSelection = selectionA;
  let replacement: Promise<"applied" | "stale"> | undefined;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "runtime",
    scope: actorScope,
    traceContext,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
    sourceCommandId: "command-actor-rollback-b",
    traceContext,
  });
  const actorRuntime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: port,
    executionFailoverScope: actorScope,
    executionFailoverScopeLifetime: "runtime",
    executionFailoverSelectionSink: (selection: ModelSelection) => {
      if (selection.providerId === selectionA.providerId && replacement) {
        throw new Error("journal compensation unavailable");
      }
      persistedSelection = selection;
      if (selection.providerId !== selectionB.providerId || replacement) return;
      replacement = port.setTarget({
        modelSelection: selectionC,
        observedTargets: { backgroundWorkIds: [actorScope.backgroundWorkId] },
        sourceCommandId: "command-actor-after-rollback-failure",
        traceContext,
      });
    },
    failoverModelFactory: ({ selection }: { selection: ModelSelection }) =>
      selection.providerId === selectionB.providerId ? modelB : createModel(selectionC, 200_000),
    setSessionModelSelection: (selection: ModelSelection) => {
      actorSelection = selection;
    },
  } as unknown as AgentRuntimeInternal;
  const state = createLoopState(modelA);

  await assert.rejects(
    () => activateExecutionFailoverAtSafeBoundary(actorRuntime, state),
    /journal compensation unavailable/,
  );
  await replacement;

  assertSameModelSelection(state.model, modelA);
  assert.deepEqual(actorSelection, selectionA);
  assert.deepEqual(persistedSelection, selectionB);
  assert.deepEqual(
    runtime.executionFailoverRegistrations.get(actorScope.backgroundWorkId)?.currentSelection,
    selectionA,
  );
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "waitingSafeBoundary");
});

test("model creation failure for a persisted active selection marks that target blocked", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverScopeLifetime: "runtime",
    failoverModelFactory: () => modelB,
    setSessionModelSelection: () => undefined,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-persisted-target-missing",
    traceContext,
  });
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "activated",
  );

  assert.equal(
    await blockExecutionFailoverTargetForModelCreationFailure(runtime, selectionB, traceContext),
    true,
  );
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "blocked");
  assert.equal(runtime.executionFailoverState?.targets[0]?.reasonCode, "target.model_unavailable");
});

test("a newer target wins when an unavailable active target is being blocked", async () => {
  const { port, runtime } = createPolicyRuntime();
  const modelA = createModel(selectionA, 100_000);
  const modelB = createModel(selectionB, 200_000);
  const modelC = createModel(selectionC, 200_000);
  Object.assign(runtime, {
    contextBuilder: null,
    contextInitialized: false,
    failoverModelFactory: () => modelB,
  });
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
    sourceCommandId: "command-unavailable-b",
    traceContext,
  });
  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, createLoopState(modelA)),
    "activated",
  );

  let replacement: Promise<"applied" | "stale"> | undefined;
  runtime.failoverModelFactory = ({ selection }) => {
    if (selection.providerId === selectionB.providerId) {
      replacement = port.setTarget({
        modelSelection: selectionC,
        observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds: [] },
        sourceCommandId: "command-c-after-unavailable-b",
        traceContext,
      });
      throw new Error("target B removed");
    }
    return modelC;
  };
  const laterTurn = createLoopState(modelA);
  assert.equal(await activateExecutionFailoverAtSafeBoundary(runtime, laterTurn), "activated");
  await replacement;
  assertSameModelSelection(laterTurn.model, modelC);
  assert.deepEqual(runtime.executionFailoverState?.modelSelection, selectionC);
  assert.equal(runtime.executionFailoverState?.targets[0]?.status, "active");
});

test("one foreground plus every admitted background becomes a real target", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const backgroundWorkIds = Array.from(
    { length: MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS },
    (_, index) => `actor-${index}`,
  );
  for (const backgroundWorkId of backgroundWorkIds) {
    await port.retain({
      currentSelection: selectionA,
      lifetime: "turn",
      scope: {
        backgroundWorkId,
        foregroundExecutionId: "foreground-1",
      },
      traceContext,
    });
  }
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds },
    sourceCommandId: "command-cap",
    traceContext,
  });
  assert.equal(
    runtime.executionFailoverState?.targets.length,
    MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS + 1,
  );
  const projected = latestFailoverPayload(events).state;
  assert.ok(projected);
  assert.deepEqual(
    projected.targets.map((target) => target.id),
    ["foreground-1", ...backgroundWorkIds],
  );
  assert.equal(executionFailoverStateSchema.safeParse(projected).success, true);

  await port.complete({ foregroundExecutionId: "foreground-1" }, traceContext);
  assert.deepEqual(
    latestFailoverPayload(events).state?.targets.map((target) => target.id),
    backgroundWorkIds,
  );
});

test("a later child inherits when the bounded target projection is already full", async () => {
  const { events, port, runtime } = createPolicyRuntime();
  const backgroundWorkIds = Array.from(
    { length: MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS },
    (_, index) => `full-${index}`,
  );
  for (const backgroundWorkId of backgroundWorkIds) {
    await port.retain({
      currentSelection: selectionA,
      lifetime: "turn",
      scope: { backgroundWorkId, foregroundExecutionId: "foreground-1" },
      traceContext,
    });
  }
  await port.setTarget({
    modelSelection: selectionB,
    observedTargets: { foregroundExecutionId: "foreground-1", backgroundWorkIds },
    sourceCommandId: "command-full-projection",
    traceContext,
  });

  const laterScope = {
    backgroundWorkId: "later-child",
    foregroundExecutionId: "foreground-1",
  } satisfies ExecutionFailoverScope;
  await port.retain({
    currentSelection: selectionA,
    lifetime: "turn",
    scope: laterScope,
    traceContext,
  });
  const target = port.resolve(laterScope);
  assert.ok(target);
  assert.equal(
    await port.activate({
      attempt: 1,
      commit: () => undefined,
      from: selectionA,
      prepare: async () => undefined,
      reasonCode: "userRequested",
      scope: laterScope,
      target,
      traceContext,
    }),
    true,
  );

  assert.equal(
    runtime.executionFailoverState?.targets.length,
    MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS + 2,
  );
  assert.equal(
    runtime.executionFailoverState?.targets.find((item) => item.id === laterScope.backgroundWorkId)
      ?.status,
    "active",
  );
  const projected = latestFailoverPayload(events).state;
  assert.ok(projected);
  assert.equal(projected.targets.length, MAX_EXECUTION_FAILOVER_TARGETS);
  assert.equal(projected.targets[0]?.id, "foreground-1");
  assert.equal(
    projected.targets.some((item) => item.id === laterScope.backgroundWorkId),
    false,
  );
  assert.equal(projected.targetCount, MAX_EXECUTION_FAILOVER_TARGETS + 1);
  assert.equal(projected.targetsTruncated, true);
  assert.equal(executionFailoverStateSchema.safeParse(projected).success, true);

  const activeTarget = port.resolve(laterScope);
  assert.ok(activeTarget);
  await port.block({
    currentSelection: selectionB,
    reasonCode: "target.model_unavailable",
    scope: laterScope,
    target: activeTarget,
    traceContext,
  });
  assert.equal(
    runtime.executionFailoverState?.targets.find((item) => item.id === laterScope.backgroundWorkId)
      ?.status,
    "blocked",
  );
  await port.complete(laterScope, traceContext);
  assert.equal(
    runtime.executionFailoverState?.targets.some((item) => item.id === laterScope.backgroundWorkId),
    false,
  );
});

test("unsafe tool state remains fenced across revisions and newer target commands", () => {
  const target = {
    id: "child-a",
    kind: "backgroundWork" as const,
    modelSelection: selectionB,
    revision: 1,
    sourceCommandId: "command-shared",
    status: "waitingSafeBoundary" as const,
  };
  let revision = 1;
  let sourceCommandId = target.sourceCommandId;
  const runtime = {
    executionFailoverPolicyPort: {
      resolve: () => ({ ...target, revision, sourceCommandId }),
    },
    executionFailoverScope: {
      backgroundWorkId: "child-a",
      foregroundExecutionId: "foreground-1",
    },
  } as unknown as AgentRuntimeInternal;
  const state = {
    executionFailoverUnsafePolicies: new Set<string>(),
    model: {
      providerId: selectionA.providerId,
      modelId: selectionA.modelId,
      options: {},
    } as Model,
  } as RegularTurnLoopState;
  markExecutionFailoverUnsafe(runtime, state);
  revision = 2;
  assert.equal(hasExecutionFailoverTarget(runtime, state), false);
  sourceCommandId = "command-new-target";
  revision = 3;
  assert.equal(hasExecutionFailoverTarget(runtime, state), false);
});

test("only structured allowlist failures are classified for failover", () => {
  assert.equal(
    classifyExecutionFailoverFailure({ context: { reason: "rate_limited", statusCode: 429 } }),
    "provider.rate_limited",
  );
  assert.equal(
    classifyExecutionFailoverFailure({ context: { reason: "invalid_request", retryable: true } }),
    undefined,
  );
  assert.equal(
    classifyExecutionFailoverFailure({ context: { reason: "context_exceeded" } }),
    "provider.context_capacity",
  );
});
