import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "./engine.js";
import { InMemoryJournalStore } from "./journal-memory.js";
import { inputHash } from "./hash.js";
import type { AskMessage, InstanceRef, WorkflowDriver } from "./types.js";

test("pausing one ask preserves independent parallel work and reruns only that ask", async () => {
  const journal = new InMemoryJournalStore();
  const started: InstanceRef[] = [];
  const messages: AskMessage[] = [];
  const cancelled: InstanceRef[] = [];
  const driver: WorkflowDriver = {
    journal,
    emit: () => {},
    createActorSession: async (actor) => ({ id: `${actor.siteId}@${actor.ordinal}` }),
    startAsk: (_session, instance, message) => {
      started.push(instance);
      messages.push(message);
    },
    respondToSubmit: () => {},
    cancelAsk: (instance) => cancelled.push(instance),
    executeWorldRead: async () => undefined,
  };
  const engine = new WorkflowEngine({
    runId: "parallel-control",
    driver,
    caps: { maxConcurrency: 2 },
    askSpecs: new Map([
      ["ask#1", { typed: false }],
      ["ask#2", { typed: false }],
    ]),
    validate: () => [],
  });
  const a = engine.createActor("actor#1", "writer");
  const b = engine.createActor("actor#2", "reviewer");
  const first = engine.ask("ask#1", a, "write");
  const second = engine.ask("ask#2", b, "review");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started.length, 2);

  assert.equal(engine.pauseAsk({ siteId: "ask#1", ordinal: 1 }), true);
  assert.equal(engine.pauseAsk({ siteId: "ask#1", ordinal: 1 }), false);
  assert.deepEqual(cancelled, [started[0]]);
  engine.askTurnEnded(started[1]!, "reviewed");
  assert.equal(await second, "reviewed");
  assert.ok(journal.listEvents("parallel-control").some((entry) =>
    entry.event.type === "node-paused" && entry.event.instance.siteId === "ask#1",
  ));

  assert.equal(engine.retryAsk({ siteId: "ask#1", ordinal: 1 }, "Use the reviewed color palette."), true);
  assert.equal(engine.retryAsk({ siteId: "ask#1", ordinal: 1 }), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started.length, 3);
  assert.match(messages[2]!.instructions, /Use the reviewed color palette\./);
  engine.askProgress(started[0]!, { turn: 9, toolCalls: 2 });
  assert.equal(journal.listEvents("parallel-control").filter((entry) =>
    entry.event.type === "node-progress" && entry.event.instance.siteId === "ask#1",
  ).length, 0);
  engine.askTurnEnded(started[0]!, "stale response");
  assert.equal(journal.getNode("parallel-control", "ask#1", 1)?.status, "running");
  engine.askTurnEnded(started[2]!, "finished");
  assert.equal(await first, "finished");
  assert.equal(journal.getNode("parallel-control", "ask#1", 1)?.result, "finished");
  engine.complete("done");
  assert.equal((await engine.settled).status, "completed");
});

test("completed-task revision imports an actor prefix and an independent actor, but reruns its target", async () => {
  const journal = new InMemoryJournalStore();
  const started: Array<{ instance: InstanceRef; message: AskMessage }> = [];
  const driver: WorkflowDriver = {
    journal,
    emit: () => {},
    createActorSession: async (actor) => ({ id: `${actor.siteId}@${actor.ordinal}` }),
    startAsk: (_session, instance, message) => { started.push({ instance, message }); },
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => undefined,
  };
  const engine = new WorkflowEngine({
    runId: "selective-revision",
    driver,
    caps: { maxConcurrency: 2 },
    askSpecs: new Map([
      ["ask#1", { typed: false }],
      ["ask#2", { typed: false }],
      ["ask#3", { typed: false }],
    ]),
    validate: () => [],
    launch: {
      inputId: "origin",
      askRevisions: [{ siteId: "ask#2", ordinal: 1, supplement: "Improve contrast.",
        attachments: [{ ref: "zcode-artifact://revision-image", fileName: "check.png", mime: "image/png", bytes: 12 }] }],
      invalidatedSites: ["ask#2"],
    },
    importedCache: {
      actors: new Map([
        ["writer", {
          persona: { name: "writer" },
          entries: [
            { inputHash: inputHash("draft"), result: "draft result", messageBoundary: 2 },
            { inputHash: inputHash("improve"), result: "old result", messageBoundary: 4 },
          ],
          transcriptSourceSessionId: "previous-writer",
        }],
        ["reviewer", {
          persona: { name: "reviewer" },
          entries: [{ inputHash: inputHash("check"), result: "independent", messageBoundary: 2 }],
          transcriptSourceSessionId: "previous-reviewer",
        }],
      ]),
      world: new Map(),
    },
  });
  const writer = engine.createActor("actor#1", "writer");
  const reviewer = engine.createActor("actor#2", "reviewer");
  assert.equal(await engine.ask("ask#1", writer, "draft"), "draft result");
  assert.equal(await engine.ask("ask#3", reviewer, "check"), "independent");
  const revised = engine.ask("ask#2", writer, "improve");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.match(started[0]!.message.instructions, /Improve contrast\./);
  assert.equal(started[0]!.message.attachments?.[0]?.ref, "zcode-artifact://revision-image");
  engine.askTurnEnded(started[0]!.instance, "new result");
  assert.equal(await revised, "new result");
  engine.complete("done");
  assert.equal((await engine.settled).status, "completed");
});

test("cold resume keeps a task-level stopped ask paused until an explicit retry", async () => {
  const journal = new InMemoryJournalStore();
  const firstStarted: InstanceRef[] = [];
  const firstMessages: AskMessage[] = [];
  const makeDriver = (started: InstanceRef[], messages: AskMessage[]): WorkflowDriver => ({
    journal,
    emit: () => {},
    createActorSession: async (actor) => ({ id: `${actor.siteId}@${actor.ordinal}` }),
    startAsk: (_session, instance, message) => {
      started.push(instance);
      messages.push(message);
    },
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => undefined,
  });
  const config = (driver: WorkflowDriver) => ({
    runId: "cold-paused-control",
    driver,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map([["ask#1", { typed: false }]]),
    validate: () => [],
  });

  const original = new WorkflowEngine(config(makeDriver(firstStarted, firstMessages)));
  const originalActor = original.createActor("actor#1", "writer");
  const interrupted = original.ask("ask#1", originalActor, "write");
  void interrupted.catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(original.pauseAsk({ siteId: "ask#1", ordinal: 1 }), true);
  const image = { ref: "zcode-artifact://image-1", fileName: "review.png", mime: "image/png", bytes: 42 };
  assert.equal(original.retryAsk({ siteId: "ask#1", ordinal: 1 }, "Keep the public API stable.", [image]), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(firstMessages[1]!.instructions, /Keep the public API stable\./);
  assert.deepEqual(firstMessages[1]!.attachments, [image]);
  assert.equal(original.pauseAsk({ siteId: "ask#1", ordinal: 1, attempt: 2 }), true);
  original.stop("user");
  await original.settled;

  const resumedStarted: InstanceRef[] = [];
  const resumedMessages: AskMessage[] = [];
  const resumed = new WorkflowEngine(config(makeDriver(resumedStarted, resumedMessages)));
  const resumedActor = resumed.createActor("actor#1", "writer");
  const result = resumed.ask("ask#1", resumedActor, "write");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumedStarted.length, 0);
  assert.equal(resumed.retryAsk({ siteId: "ask#1", ordinal: 1, attempt: 2 }), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(resumedStarted, [{ siteId: "ask#1", ordinal: 1, attempt: 3 }]);
  assert.match(resumedMessages[0]!.instructions, /Keep the public API stable\./);
  assert.deepEqual(resumedMessages[0]!.attachments, [image]);
  resumed.askTurnEnded(resumedStarted[0]!, "done");
  assert.equal(await result, "done");
  resumed.complete("done");
  assert.equal((await resumed.settled).status, "completed");
});
