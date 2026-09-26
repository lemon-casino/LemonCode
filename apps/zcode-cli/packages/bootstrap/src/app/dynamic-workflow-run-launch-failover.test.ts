import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJournalStore, type ActorRef } from "@zcode/dynamic-workflow";
import type { ModelSelection } from "@zcode/contracts";
import { journalActorResolvedModel } from "./dynamic-workflow-run-launch.js";

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
