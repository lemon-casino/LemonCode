import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryJournalStore, type AskActivity, type RunEvent } from "@lcode/dynamic-workflow";
import { runWorkflowScript } from "./harness.js";

test("the real harness forwards activity through its late-bound sink without settling the ask", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-activity-harness-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const journal = new InMemoryJournalStore();
  const events: RunEvent[] = [];
  const activity: AskActivity = {
    kind: "model",
    observedAt: 1_700_000_000_000,
    since: 1_700_000_000_000,
    requestsCompleted: 0,
    toolCalls: 0,
    requestId: "fixture-request",
  };
  const settlement = await runWorkflowScript({
    cwd,
    runId: "activity-fixture",
    lowered:
      'const actor = __host.createActor("actor#1", "fixture"); return await __host.ask("ask#1", actor, "fixture");',
    caps: { maxConcurrency: 1 },
    askSpecs: new Map([["ask#1", { typed: false }]]),
    validate: () => [],
    timeoutMs: 10_000,
    makeDriver: (sink) => ({
      journal,
      emit: (event) => events.push(event),
      createActorSession: async () => ({ id: "fixture-session" }),
      startAsk: (_session, instance) => {
        sink.askActivity(instance, activity);
        assert.equal(
          journal.getNode("activity-fixture", instance.siteId, instance.ordinal)?.status,
          "running",
        );
        assert.equal(journal.getRun("activity-fixture")?.spentTokens, 0);
        sink.askTurnEnded(instance, "accepted fixture result");
      },
      respondToSubmit: () => {},
      cancelAsk: () => {},
      executeWorldRead: async () => undefined,
    }),
  });
  assert.equal(settlement.status, "completed");
  assert.deepEqual(
    events.filter((event) => event.type === "node-activity").map((event) => event.activity),
    [activity],
  );
  assert.equal(events.filter((event) => event.type === "node-settled").length, 1);
  assert.equal(journal.getNode("activity-fixture", "ask#1", 1)?.result, "accepted fixture result");
});
