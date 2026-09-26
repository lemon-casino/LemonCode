import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "./engine.js";
import { ImportedActorState } from "./imported-cache.js";
import { InMemoryJournalStore } from "./journal-memory.js";
import type { WorkflowDriver } from "./types.js";

test("an imported actor seed carries model selection and provenance as one binding", () => {
  const state = new ImportedActorState({
    persona: { name: "writer" },
    entries: [{ inputHash: "same", result: "done", messageBoundary: 4 }],
    transcriptSourceSessionId: "source-session",
    resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
    modelProvenance: "resumePin",
  });

  assert.ok(state.take(0, "same"));
  assert.deepEqual(state.seed(), {
    sourceSessionId: "source-session",
    messageCount: 4,
    resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
    modelProvenance: "resumePin",
  });
});

test("engine and scheduler actor row replacements preserve the complete model binding", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: "resume-run",
    status: "running",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
  });
  journal.putActor({
    runId: "resume-run",
    siteId: "actor#1",
    ordinal: 1,
    name: "writer",
    persona: { name: "writer" },
    sessionId: "old-session",
    resolvedModel: 'selection:{"providerId":"provider-b","modelId":"model-b"}',
    modelProvenance: "sessionInherited",
  });
  const driver: WorkflowDriver = {
    journal,
    emit: () => {},
    createActorSession: async () => ({ id: "resumed-session" }),
    startAsk: () => {},
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => undefined,
  };
  const engine = new WorkflowEngine({
    runId: "resume-run",
    driver,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map([["ask#1", { typed: false }]]),
    validate: () => [],
  });

  const actor = engine.createActor("actor#1", "writer");
  assert.equal(journal.getActor("resume-run", "actor#1", 1)?.modelProvenance, "sessionInherited");
  const pending = engine.ask("ask#1", actor, "continue");
  void pending.catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(journal.getActor("resume-run", "actor#1", 1), {
    runId: "resume-run",
    siteId: "actor#1",
    ordinal: 1,
    name: "writer",
    persona: { name: "writer" },
    sessionId: "resumed-session",
    resolvedModel: 'selection:{"providerId":"provider-b","modelId":"model-b"}',
    modelProvenance: "sessionInherited",
  });
  engine.stop("user");
  await engine.settled;
});
