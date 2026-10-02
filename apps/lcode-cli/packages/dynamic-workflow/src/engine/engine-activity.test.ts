import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "./engine.js";
import { InMemoryJournalStore } from "./journal-memory.js";
import type { AskActivity, InstanceRef, RunEvent, WorkflowDriver } from "./types.js";

const activity: AskActivity = {
  kind: "model",
  observedAt: 1_700_000_000_000,
  since: 1_700_000_000_000,
  requestsCompleted: 2,
  toolCalls: 3,
  requestId: "request-3",
};

function setup() {
  const journal = new InMemoryJournalStore();
  const events: RunEvent[] = [];
  const started: InstanceRef[] = [];
  const driver: WorkflowDriver = {
    journal,
    emit: (event) => events.push(event),
    createActorSession: async () => ({ id: "activity-session" }),
    startAsk: (_session, instance) => started.push(instance),
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => undefined,
  };
  const engine = new WorkflowEngine({
    runId: "activity-test",
    driver,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map([["ask#1", { typed: true }]]),
    validate: () => [],
  });
  const actor = engine.createActor("actor#1", "worker");
  const result = engine.ask("ask#1", actor, "return the accepted result");
  return { engine, journal, events, started, result };
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("ask activity journals facts without settling the ask, changing progress, or charging usage", async () => {
  const h = setup();
  await nextTick();
  const instance = h.started[0]!;
  const beforeNode = h.journal.getNode("activity-test", "ask#1", 1);
  const beforeRun = h.journal.getRun("activity-test");
  let delivered = false;
  void h.result.then(() => {
    delivered = true;
  });
  h.engine.askActivity(instance, activity);
  await nextTick();

  assert.equal(delivered, false);
  assert.deepEqual(h.journal.getNode("activity-test", "ask#1", 1), beforeNode);
  assert.deepEqual(h.journal.getRun("activity-test"), beforeRun);
  const expected = { type: "node-activity", instance, activity };
  assert.deepEqual(h.events.at(-1), expected);
  assert.deepEqual(h.journal.listEvents("activity-test").at(-1)?.event, expected);
  assert.equal(
    h.events.some((event) => event.type === "node-progress"),
    false,
  );
  assert.equal(
    h.events.some((event) => event.type === "node-settled"),
    false,
  );

  h.engine.askSubmitAttempted(instance, { done: true });
  assert.deepEqual(await h.result, { done: true });
  const count = h.events.length;
  h.engine.askActivity(instance, activity);
  assert.equal(h.events.length, count, "settled asks reject late observations");
  h.engine.complete("done");
  const settledCount = h.events.length;
  h.engine.askActivity(instance, activity);
  assert.equal(h.events.length, settledCount, "run-settled remains the last event");
});

test("paused, unknown and obsolete ask attempts cannot publish activity", async () => {
  const h = setup();
  await nextTick();
  const first = h.started[0]!;
  h.engine.pauseAsk(first);
  const pausedCount = h.events.length;
  h.engine.askActivity(first, activity);
  h.engine.askActivity({ siteId: "missing", ordinal: 1 }, activity);
  assert.equal(h.events.length, pausedCount);
  h.engine.retryAsk(first);
  await nextTick();
  const second = h.started[1]!;
  const retryCount = h.events.length;
  h.engine.askActivity(first, activity);
  assert.equal(h.events.length, retryCount);
  h.engine.askActivity(second, activity);
  assert.deepEqual(h.events.at(-1), { type: "node-activity", instance: second, activity });
  const rejected = assert.rejects(h.result, /stopped|cancelled/i);
  h.engine.stop("user");
  await rejected;
  const stoppedCount = h.events.length;
  h.engine.askActivity(second, activity);
  assert.equal(h.events.length, stoppedCount);
});
