import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_SUBMIT_PROFILE,
  InMemoryJournalStore,
  type ActorRef,
} from "@lcode/dynamic-workflow";
import {
  CoreErrorType,
  createSessionId,
  type CreateSessionTaskLinkInput,
  type ModelSelection,
  type WorkflowEscalatePort,
} from "@lcode/contracts";
import type { AgentRuntime } from "@lcode/core";
import { journalActorResolvedModel } from "./dynamic-workflow-run-launch.js";
import type { DynamicWorkflowActorRuntimeInput } from "./dynamic-workflow-run-service.js";
import {
  createWorkflowActorRuntimeFactory,
  journalActorResolvedModel as journalRuntimeActorModel,
} from "./workflow-actor-runtime.js";
import { defer } from "./workflow-driver-helpers.js";
import type { ActorRuntimeFactory } from "./workflow-driver-types.js";

test("failover selection atomically refreshes the actor binding without erasing actor fields", () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-failover-pin";
  const actor = { siteId: "agent#1", ordinal: 1 } satisfies ActorRef;
  const selection = {
    providerId: "provider-b",
    modelId: "model-b",
    options: { reasoningLevel: "high", speed: "fast" },
  } satisfies ModelSelection;
  journal.createRun({
    runId,
    status: "running",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
  });
  journal.putActor({
    runId,
    ...actor,
    name: "reviewer",
    persona: { name: "reviewer", system: "Review carefully." },
    sessionId: "sess_actor_1",
    resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
    modelProvenance: "sessionInherited",
  });

  journalActorResolvedModel({
    actor,
    journal,
    selection,
    modelProvenance: "sessionInherited",
    runId,
  });

  assert.deepEqual(journal.getActor(runId, actor.siteId, actor.ordinal), {
    runId,
    ...actor,
    name: "reviewer",
    persona: { name: "reviewer", system: "Review carefully." },
    sessionId: "sess_actor_1",
    resolvedModel: `selection:${JSON.stringify(selection)}`,
    modelProvenance: "sessionInherited",
  });
});

test("a failed actor binding write leaves both selection and provenance unchanged", () => {
  const backing = new InMemoryJournalStore();
  const runId = "run-failover-write-failure";
  const actor = { siteId: "agent#1", ordinal: 1 } satisfies ActorRef;
  backing.createRun({
    runId,
    status: "running",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
  });
  backing.putActor({
    runId,
    ...actor,
    resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
    modelProvenance: "sessionInherited",
  });
  const journal = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === "putActor")
        return () => {
          throw new Error("write failed");
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  assert.throws(
    () =>
      journalActorResolvedModel({
        actor,
        journal,
        selection: { providerId: "provider-b", modelId: "model-b" },
        modelProvenance: "sessionInherited",
        runId,
      }),
    /write failed/,
  );
  assert.deepEqual(backing.getActor(runId, actor.siteId, actor.ordinal), {
    runId,
    ...actor,
    resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
    modelProvenance: "sessionInherited",
  });
});

const actor: ActorRef = { siteId: "agent#1", ordinal: 1 };
const selection: ModelSelection = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "high", speed: "fast" },
};

function actorInput(): Parameters<ActorRuntimeFactory>[0] {
  return {
    actor,
    sessionId: createSessionId("actor-runtime-order"),
    persona: { name: "reviewer" },
    submitProfile: GENERIC_SUBMIT_PROFILE,
    submitPort: { respond: async () => ({ accept: true }) },
    escalatePort: {} as WorkflowEscalatePort,
  };
}

function actorJournal(runId: string) {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId, status: "running", caps: { maxConcurrency: 1 }, spentTokens: 0 });
  journal.putActor({ runId, ...actor, name: "reviewer", persona: { name: "reviewer" } });
  return journal;
}

test("launch keeps the actor model journal export at its original entrypoint", () => {
  assert.equal(journalActorResolvedModel, journalRuntimeActorModel);
});

test("actor runtime persists the model binding and session before creating its parent task link", async () => {
  const runId = "actor-runtime-persist-order";
  const journal = actorJournal(runId);
  const input = actorInput();
  const order: string[] = [];
  const persisted = defer<void>();
  const links: CreateSessionTaskLinkInput[] = [];
  let runtimeInput!: DynamicWorkflowActorRuntimeInput;
  const runtime = {
    getSessionModelSelection: () => selection,
    ensureSessionPersistedForExternalActivity: async () => {
      const binding = journal.getActor(runId, actor.siteId, actor.ordinal);
      assert.equal(binding?.resolvedModel, `selection:${JSON.stringify(selection)}`);
      assert.equal(binding?.modelProvenance, "runModel");
      order.push("session");
      await persisted.promise;
    },
    resumeFromStore: async () => {
      assert.fail("fresh actors must not be rehydrated");
    },
    subscribeEvents: () => {
      assert.fail("transcript sink is attached by runtime construction");
    },
  } as unknown as AgentRuntime;
  const factory = createWorkflowActorRuntimeFactory({
    deps: {
      journal,
      createActorRuntime: (value) => {
        runtimeInput = value;
        order.push("runtime");
        return runtime;
      },
      taskLinkStore: {
        createSessionTaskLink: async (link) => {
          links.push(link);
          order.push("link");
        },
      },
    },
    runId,
    parentSessionId: "parent-session",
    executionFailoverLineageId: "foreground-frozen",
    recordedActorModels: { defaultProvenance: "runModel", overrides: [] },
    runSubagentModel: selection,
  });
  const creating = factory(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(order, ["runtime", "session"]);
    assert.equal(links.length, 0);
    assert.deepEqual(runtimeInput.actorModelSelection, selection);
    assert.equal(runtimeInput.actorModelProvenance, "runModel");
    assert.equal(runtimeInput.executionFailoverLineageId, "foreground-frozen");
    assert.equal(runtimeInput.submitPort, input.submitPort);
    assert.equal(runtimeInput.escalatePort, input.escalatePort);
  } finally {
    persisted.resolve();
  }
  assert.equal(await creating, runtime);
  assert.deepEqual(order, ["runtime", "session", "link"]);
  assert.equal(links[0]?.childSessionId, input.sessionId);
  assert.equal(links[0]?.parentSessionId, "parent-session");
  assert.equal(links[0]?.path, `dwf/${runId}/agent#1@1`);
  assert.equal(links[0]?.role, "workflow_actor");
  assert.equal(links[0]?.rootWorkflowRunId, undefined);
});

test("same-run resume reads its binding before overwriting it and preserves failover provenance", async () => {
  const runId = "actor-runtime-resume";
  const journal = actorJournal(runId);
  const input = actorInput();
  const initial = journal.getActor(runId, actor.siteId, actor.ordinal)!;
  journal.putActor({
    ...initial,
    sessionId: input.sessionId,
    resolvedModel: `selection:${JSON.stringify(selection)}`,
    modelProvenance: "sessionInherited",
  });
  const continued: ModelSelection = { ...selection, modelId: "model-b" };
  const switched: ModelSelection = { ...selection, modelId: "model-c" };
  let runtimeInput!: DynamicWorkflowActorRuntimeInput;
  let rehydrated = 0;
  const runtime = {
    getSessionModelSelection: () => continued,
    resumeFromStore: async () => {
      assert.equal(
        journal.getActor(runId, actor.siteId, actor.ordinal)?.resolvedModel,
        `selection:${JSON.stringify(continued)}`,
      );
      rehydrated++;
    },
    ensureSessionPersistedForExternalActivity: async () => {
      assert.fail("resume must not persist again");
    },
  } as unknown as AgentRuntime;
  const factory = createWorkflowActorRuntimeFactory({
    deps: {
      journal,
      createActorRuntime: (value) => {
        runtimeInput = value;
        return runtime;
      },
      taskLinkStore: {
        createSessionTaskLink: async () => {
          assert.fail("resume must not recreate its task link");
        },
      },
    },
    runId,
    recordedActorModels: { defaultProvenance: "sessionInherited", overrides: [] },
  });
  await factory({
    ...input,
    seed: {
      sourceSessionId: "predecessor-session",
      messageCount: 1,
      resolvedModel: `selection:${JSON.stringify(switched)}`,
      modelProvenance: "resumePin",
    },
  });
  assert.deepEqual(runtimeInput.actorModelSelection, selection);
  assert.equal(runtimeInput.actorModelProvenance, "sessionInherited");
  assert.equal(rehydrated, 1);
  assert.ok(runtimeInput.onExecutionFailoverSelection);
  await runtimeInput.onExecutionFailoverSelection(switched);
  assert.deepEqual(journal.getActor(runId, actor.siteId, actor.ordinal), {
    ...initial,
    sessionId: input.sessionId,
    resolvedModel: `selection:${JSON.stringify(switched)}`,
    modelProvenance: "sessionInherited",
  });
});

test("only SessionNotFound falls back from rehydration to fresh session persistence", async () => {
  for (const missing of [true, false]) {
    const runId = `actor-runtime-rehydrate-${missing}`;
    const journal = actorJournal(runId);
    const input = actorInput();
    journal.putActor({
      ...journal.getActor(runId, actor.siteId, actor.ordinal)!,
      sessionId: input.sessionId,
    });
    const failure = missing
      ? { type: CoreErrorType.SessionNotFound }
      : new Error("store unavailable");
    const order: string[] = [];
    const factory = createWorkflowActorRuntimeFactory({
      deps: {
        journal,
        createActorRuntime: () =>
          ({
            getSessionModelSelection: () => selection,
            resumeFromStore: async () => {
              order.push("resume");
              throw failure;
            },
            ensureSessionPersistedForExternalActivity: async () => {
              order.push("session");
            },
          }) as unknown as AgentRuntime,
        taskLinkStore: {
          createSessionTaskLink: async () => {
            order.push("link");
          },
        },
      },
      runId,
      recordedActorModels: { overrides: [] },
    });
    if (missing) {
      await factory(input);
      assert.deepEqual(order, ["resume", "session", "link"]);
    } else {
      await assert.rejects(async () => factory(input), (error) => error === failure);
      assert.deepEqual(order, ["resume"]);
    }
  }
});
