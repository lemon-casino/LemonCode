import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJournalStore, WorkflowEngine, inputHash, type WorkflowDriver } from "@zcode/dynamic-workflow";
import { buildImportedCache, rebuildImportedCacheForResume } from "./dynamic-workflow-import.js";

test("world imports preserve unsuccessful occurrences across amendment and cold reconstruction", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "previous", status: "completed", caps: { maxConcurrency: 1 }, spentTokens: 0 });
  const hash = inputHash({ op: "read", args: ["file.txt"] });
  journal.putNode({ runId: "previous", siteId: "world#1", ordinal: 1, kind: "world-read", inputHash: hash, status: "failed" });
  journal.putNode({ runId: "previous", siteId: "world#2", ordinal: 1, kind: "world-read", inputHash: hash, status: "completed", result: "old second read" });
  journal.putNode({ runId: "previous", siteId: "world#3", ordinal: 1, kind: "world-read", inputHash: hash, status: "completed", result: "old third read" });

  const imported = await buildImportedCache({ journal }, "previous");
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const rebuilt = await rebuildImportedCacheForResume({ journal }, { runId: "successor", predecessorRunId: "previous" });
  assert.deepEqual(rebuilt, imported.cache);

  let reads = 0;
  const driver: WorkflowDriver = {
    journal,
    emit: () => {},
    createActorSession: async () => ({ id: "unused" }),
    startAsk: () => {},
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => { reads++; return "fresh first read"; },
  };
  const engine = new WorkflowEngine({
    runId: "successor", driver, caps: { maxConcurrency: 1 }, askSpecs: new Map(),
    validate: () => [], importedCache: rebuilt,
  });
  assert.equal(await engine.worldRead("new#1", "read", ["file.txt"]), "fresh first read");
  assert.equal(await engine.worldRead("new#2", "read", ["file.txt"]), "old second read");
  assert.equal(reads, 1);
  const resumed = new WorkflowEngine({
    runId: "successor", driver, caps: { maxConcurrency: 1 }, askSpecs: new Map(),
    validate: () => [], importedCache: rebuilt,
  });
  assert.equal(await resumed.worldRead("new#1", "read", ["file.txt"]), "fresh first read");
  assert.equal(await resumed.worldRead("new#2", "read", ["file.txt"]), "old second read");
  assert.equal(await resumed.worldRead("new#3", "read", ["file.txt"]), "old third read");
  assert.equal(reads, 1);
});

test("a completed world run is reused without repeating its side effect after restart", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "previous-effect", status: "completed", caps: { maxConcurrency: 1 }, spentTokens: 0 });
  journal.putNode({
    runId: "previous-effect", siteId: "effect#1", ordinal: 1, kind: "world-run",
    inputHash: inputHash({ op: "run", args: ["echo okay"] }), status: "completed", result: "done",
  });
  const imported = await buildImportedCache({ journal }, "previous-effect");
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  let executions = 0;
  const driver: WorkflowDriver = {
    journal, emit: () => {}, createActorSession: async () => ({ id: "unused" }),
    startAsk: () => {}, respondToSubmit: () => {}, cancelAsk: () => {},
    executeWorldRead: async () => { executions++; return "unexpected"; },
  };
  const config = () => ({
    runId: "successor-effect", driver, caps: { maxConcurrency: 1 }, askSpecs: new Map(),
    validate: () => [], importedCache: imported.cache,
  });
  assert.equal(await new WorkflowEngine(config()).worldRead("new-effect", "run", ["echo okay"]), "done");
  assert.equal(await new WorkflowEngine(config()).worldRead("new-effect", "run", ["echo okay"]), "done");
  assert.equal(executions, 0);
});
