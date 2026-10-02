import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "./engine.js";
import { inputHash } from "./hash.js";
import { InMemoryJournalStore } from "./journal-memory.js";
import { WorkflowError } from "./types.js";
import type { ImportedRunCache, InstanceRef, RunEvent, WorkflowDriver } from "./types.js";

type AdmissionEvent = Extract<RunEvent, { type: "node-admission" }>;
type BlockedAdmissionEvent = Extract<AdmissionEvent, { cause: "actor-fifo" | "run-capacity" }>;
const RUN_ID = "scheduler-admission";
const ASK_SITES = ["ask#1", "ask#2", "ask#3", "ask#4", "ask#5", "ask#6"];
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const instance = (siteId: string, attempt?: number): InstanceRef => ({
  siteId,
  ordinal: 1,
  ...(attempt === undefined ? {} : { attempt }),
});

function admission(
  siteId: string,
  cause: BlockedAdmissionEvent["cause"],
  blockedBy?: InstanceRef,
  attempt?: number,
): AdmissionEvent {
  return {
    type: "node-admission",
    instance: instance(siteId, attempt),
    cause,
    ...(blockedBy === undefined ? {} : { blockedBy }),
  };
}

function setup(
  maxConcurrency: number,
  options: {
    journal?: InMemoryJournalStore;
    importedCache?: ImportedRunCache;
    createActorSession?: WorkflowDriver["createActorSession"];
  } = {},
) {
  const journal = options.journal ?? new InMemoryJournalStore();
  const events: RunEvent[] = [];
  const started: InstanceRef[] = [];
  const cancelled: InstanceRef[] = [];
  const driver: WorkflowDriver = {
    journal,
    emit: (event) => events.push(event),
    createActorSession:
      options.createActorSession ?? (async (actor) => ({ id: `${actor.siteId}@${actor.ordinal}` })),
    startAsk: (_session, ref) => started.push(ref),
    respondToSubmit: () => {},
    cancelAsk: (ref) => cancelled.push(ref),
    executeWorldRead: async () => undefined,
  };
  const engine = new WorkflowEngine({
    runId: RUN_ID,
    driver,
    caps: { maxConcurrency },
    askSpecs: new Map(ASK_SITES.map((siteId) => [siteId, { typed: false }] as const)),
    validate: () => [],
    ...(options.importedCache === undefined ? {} : { importedCache: options.importedCache }),
  });
  const ask = (siteId: string, actor: string) => {
    const result = engine.ask(siteId, actor, siteId);
    // 测试可显式停止旧实例模拟冷恢复；提前接住停止拒绝，避免其掩盖观察事件断言。
    void result.catch(() => {});
    return result;
  };
  const admissions = (siteId?: string) =>
    events
      .filter(
        (event): event is BlockedAdmissionEvent =>
          event.type === "node-admission" && event.cause !== null,
      )
      .filter((event) => siteId === undefined || event.instance.siteId === siteId);
  const nodeEvents = (siteId: string) =>
    events.filter((event) => "instance" in event && event.instance.siteId === siteId);
  return { engine, journal, events, started, cancelled, ask, admissions, nodeEvents };
}

test("cap=1 reports run capacity only for the ready head, without changing dispatch order", async () => {
  const h = setup(1);
  const firstActor = h.engine.createActor("actor#1", "first");
  const secondActor = h.engine.createActor("actor#2", "second");
  h.engine.createActor("actor#3", "not-called");
  const first = h.ask("ask#1", firstActor);
  const second = h.ask("ask#2", secondActor);
  const third = h.ask("ask#3", secondActor);
  await nextTick();

  assert.deepEqual(h.started, [instance("ask#1")]);
  assert.deepEqual(h.admissions(), [
    admission("ask#2", "run-capacity"),
    admission("ask#3", "actor-fifo", instance("ask#2")),
  ]);
  assert.deepEqual(
    h.nodeEvents("ask#2").map((event) => event.type),
    ["node-queued", "node-admission"],
  );
  assert.equal(h.journal.listNodes(RUN_ID).length, 3, "an uncalled actor has no queued node");

  h.engine.askTurnEnded(instance("ask#1"), "first result");
  assert.equal(await first, "first result");
  await nextTick();
  assert.deepEqual(h.started, [instance("ask#1"), instance("ask#2")]);
  assert.deepEqual(h.nodeEvents("ask#2").slice(1), [
    admission("ask#2", "run-capacity"),
    { type: "node-admission", instance: instance("ask#2"), cause: null },
    { type: "node-dispatched", instance: instance("ask#2") },
  ]);
  h.engine.askWaiting(instance("ask#2"), { cause: "slot" });
  h.engine.askExecuting(instance("ask#2"));
  assert.equal(h.admissions().length, 2, "provider waiting is not scheduler admission");
  h.engine.askTurnEnded(instance("ask#2"), "second result");
  assert.equal(await second, "second result");
  await nextTick();
  h.engine.askTurnEnded(instance("ask#3"), "third result");
  assert.equal(await third, "third result");
  assert.deepEqual(
    h.started,
    ASK_SITES.slice(0, 3).map((siteId) => instance(siteId)),
  );
  assert.equal(
    h.admissions().length,
    2,
    "a dispatch or settlement never republishes its old cause",
  );
  h.engine.complete("done");
});

test("same-actor FIFO names each predecessor and does not block an independent actor", async () => {
  const h = setup(2);
  const serial = h.engine.createActor("actor#1", "serial");
  const independent = h.engine.createActor("actor#2", "independent");
  const first = h.ask("ask#1", serial);
  const second = h.ask("ask#2", serial);
  const third = h.ask("ask#3", serial);
  const parallel = h.ask("ask#4", independent);
  await nextTick();

  assert.deepEqual(h.started, [instance("ask#1"), instance("ask#4")]);
  assert.deepEqual(h.admissions(), [
    admission("ask#2", "actor-fifo", instance("ask#1")),
    admission("ask#3", "actor-fifo", instance("ask#2")),
  ]);
  h.engine.askTurnEnded(instance("ask#4"), "parallel result");
  assert.equal(await parallel, "parallel result");
  assert.equal(h.admissions().length, 2, "a free run slot does not change the FIFO cause");
  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  assert.deepEqual(
    h.admissions("ask#3"),
    [admission("ask#3", "actor-fifo", instance("ask#2"))],
    "moving the predecessor from queue to current is not a new cause",
  );
  h.engine.askTurnEnded(instance("ask#2"), "second result");
  await second;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#3"), "third result");
  await third;
  h.engine.complete("done");
});

test("finishing the FIFO predecessor changes the cause when another actor receives the slot", async () => {
  const h = setup(1);
  // actorOrder 是既有派发顺序；观察不能让当前 actor 的后项抢走先注册 actor 的名额。
  const earlier = h.engine.createActor("actor#1", "earlier");
  const serial = h.engine.createActor("actor#2", "serial");
  const first = h.ask("ask#1", serial);
  const follower = h.ask("ask#2", serial);
  const competing = h.ask("ask#3", earlier);
  await nextTick();
  assert.deepEqual(h.admissions("ask#2"), [admission("ask#2", "actor-fifo", instance("ask#1"))]);

  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  assert.deepEqual(h.started, [instance("ask#1"), instance("ask#3")]);
  assert.deepEqual(
    h.admissions("ask#2"),
    [admission("ask#2", "actor-fifo", instance("ask#1")), admission("ask#2", "run-capacity")],
    "run capacity must not retain the old FIFO blockedBy",
  );
  h.engine.askFailed(instance("ask#3"), new WorkflowError("DriverError", "synthetic failure"));
  await assert.rejects(competing, /synthetic failure/);
  await nextTick();
  h.engine.askTurnEnded(instance("ask#2"), "follower result");
  assert.equal(await follower, "follower result");
  assert.equal(h.admissions("ask#2").length, 2);
  h.engine.complete("done");
});

test("pause frees capacity but retains FIFO, and retry updates the actual blocking attempt", async () => {
  const h = setup(1);
  const serial = h.engine.createActor("actor#1", "serial");
  const independent = h.engine.createActor("actor#2", "independent");
  const first = h.ask("ask#1", serial);
  const follower = h.ask("ask#2", serial);
  const parallel = h.ask("ask#3", independent);
  await nextTick();
  assert.equal(h.engine.pauseAsk(instance("ask#1")), true);
  await nextTick();
  assert.deepEqual(h.started, [instance("ask#1"), instance("ask#3")]);
  assert.deepEqual(h.cancelled, [instance("ask#1")]);
  assert.deepEqual(
    h.admissions("ask#2"),
    [admission("ask#2", "actor-fifo", instance("ask#1"))],
    "pausing a predecessor does not invent a different blocker",
  );

  assert.equal(h.engine.retryAsk(instance("ask#1")), true);
  assert.deepEqual(h.admissions("ask#1"), [admission("ask#1", "run-capacity", undefined, 2)]);
  assert.deepEqual(
    h.admissions("ask#2"),
    [
      admission("ask#2", "actor-fifo", instance("ask#1")),
      admission("ask#2", "actor-fifo", instance("ask#1", 2)),
    ],
    "the historical blocker must not be mutated when its attempt changes",
  );
  const eventCount = h.events.length;
  h.engine.askTurnEnded(instance("ask#1"), "obsolete result");
  h.engine.askFailed(instance("ask#1"), new WorkflowError("DriverError", "obsolete failure"));
  assert.equal(h.engine.pauseAsk(instance("ask#1")), false);
  assert.equal(h.engine.retryAsk(instance("ask#1")), false);
  assert.equal(h.events.length, eventCount, "obsolete attempt callbacks cannot refresh admission");

  h.engine.askTurnEnded(instance("ask#3"), "parallel result");
  await parallel;
  await nextTick();
  assert.deepEqual(h.started.at(-1), instance("ask#1", 2));
  h.engine.askTurnEnded(instance("ask#1", 2), "revised result");
  assert.equal(await first, "revised result");
  await nextTick();
  h.engine.askTurnEnded(instance("ask#2"), "follower result");
  await follower;
  h.engine.complete("done");
});

test("pausing a queued predecessor updates the blocker without relabeling its followers as capacity", async () => {
  const h = setup(2);
  const serial = h.engine.createActor("actor#1", "serial");
  const independent = h.engine.createActor("actor#2", "independent");
  const first = h.ask("ask#1", serial);
  const paused = h.ask("ask#2", serial);
  const follower = h.ask("ask#3", serial);
  const parallel = h.ask("ask#4", independent);
  await nextTick();
  assert.equal(h.engine.pauseAsk(instance("ask#2")), true);
  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  assert.deepEqual(h.started, [instance("ask#1"), instance("ask#4")]);
  assert.deepEqual(h.admissions("ask#3"), [admission("ask#3", "actor-fifo", instance("ask#2"))]);
  h.engine.askTurnEnded(instance("ask#4"), "parallel result");
  await parallel;
  assert.equal(h.engine.retryAsk(instance("ask#2")), true);
  await nextTick();
  assert.deepEqual(
    h.admissions("ask#3").at(-1),
    admission("ask#3", "actor-fifo", instance("ask#2", 2)),
  );
  assert.equal(
    h.admissions("ask#2").length,
    1,
    "an immediately dispatchable retry has no old cause",
  );
  h.engine.askTurnEnded(instance("ask#2", 2), "retry result");
  await paused;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#3"), "follower result");
  await follower;
  h.engine.complete("done");
});

test("retrying a queued ask re-emits even the same cause only for its new attempt", async () => {
  const h = setup(1);
  const running = h.engine.createActor("actor#1", "running");
  const waiting = h.engine.createActor("actor#2", "waiting");
  const first = h.ask("ask#1", running);
  const queued = h.ask("ask#2", waiting);
  const follower = h.ask("ask#3", waiting);
  await nextTick();
  assert.equal(h.engine.pauseAsk(instance("ask#2")), true);
  assert.equal(h.admissions("ask#2").length, 1, "paused nodes publish no admission");
  assert.deepEqual(h.cancelled, [], "a queued ask never acquired a driver turn");
  assert.equal(h.engine.retryAsk(instance("ask#2")), true);
  assert.deepEqual(h.admissions("ask#2"), [
    admission("ask#2", "run-capacity"),
    admission("ask#2", "run-capacity", undefined, 2),
  ]);
  assert.deepEqual(
    h.nodeEvents("ask#2").map((event) => event.type),
    ["node-queued", "node-admission", "node-paused", "node-retried", "node-admission"],
  );
  assert.deepEqual(h.admissions("ask#3"), [
    admission("ask#3", "actor-fifo", instance("ask#2")),
    admission("ask#3", "actor-fifo", instance("ask#2", 2)),
  ]);

  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#2", 2), "retry result");
  await queued;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#3"), "follower result");
  await follower;
  h.engine.complete("done");
});

test("a slot reserved for session creation is not reported as another capacity wait", async () => {
  let releaseSession!: (value: { id: string }) => void;
  const session = new Promise<{ id: string }>((resolve) => {
    releaseSession = resolve;
  });
  const h = setup(1, { createActorSession: () => session });
  const serial = h.engine.createActor("actor#1", "serial");
  const other = h.engine.createActor("actor#2", "other");
  const first = h.ask("ask#1", serial);
  const follower = h.ask("ask#2", serial);
  const parallel = h.ask("ask#3", other);
  await nextTick();
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.admissions(), [
    admission("ask#2", "actor-fifo", instance("ask#1")),
    admission("ask#3", "run-capacity"),
  ]);
  assert.deepEqual(
    h.nodeEvents("ask#1").map((event) => event.type),
    ["node-queued"],
  );

  releaseSession({ id: "synthetic-session" });
  await nextTick();
  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#2"), "follower result");
  await follower;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#3"), "parallel result");
  await parallel;
  assert.equal(h.admissions().length, 2);
  h.engine.complete("done");
});

test("reserving capacity clears a previous cause before slow session creation without dispatching early", async () => {
  let releaseSession!: (value: { id: string }) => void;
  const session = new Promise<{ id: string }>((resolve) => {
    releaseSession = resolve;
  });
  const h = setup(1, {
    createActorSession: (actor) =>
      actor.siteId === "actor#2" ? session : Promise.resolve({ id: "first-session" }),
  });
  const firstActor = h.engine.createActor("actor#1", "first");
  const queuedActor = h.engine.createActor("actor#2", "queued");
  const first = h.ask("ask#1", firstActor);
  const queued = h.ask("ask#2", queuedActor);
  const follower = h.ask("ask#3", queuedActor);
  await nextTick();
  const beforeNode = h.journal.getNode(RUN_ID, "ask#2", 1);
  const beforeRun = h.journal.getRun(RUN_ID);
  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  assert.deepEqual(h.started, [instance("ask#1")]);
  assert.deepEqual(
    h.nodeEvents("ask#2").slice(1),
    [
      admission("ask#2", "run-capacity"),
      { type: "node-admission", instance: instance("ask#2"), cause: null },
    ],
    "a reserved slot is no longer waiting for capacity, even before node-dispatched",
  );
  assert.deepEqual(h.journal.getNode(RUN_ID, "ask#2", 1), beforeNode);
  assert.deepEqual(h.journal.getRun(RUN_ID), beforeRun);
  assert.deepEqual(h.admissions("ask#3"), [admission("ask#3", "actor-fifo", instance("ask#2"))]);
  const repeatedPump = h.ask("ask#4", firstActor);
  assert.equal(
    h.nodeEvents("ask#2").filter((event) => event.type === "node-admission" && event.cause === null)
      .length,
    1,
  );

  assert.equal(h.engine.pauseAsk(instance("ask#2")), true);
  await nextTick();
  assert.equal(h.engine.retryAsk(instance("ask#2")), true);
  const eventCount = h.events.length;
  releaseSession({ id: "second-session" });
  await nextTick();
  assert.equal(
    h.events.length,
    eventCount,
    "late session readiness for the paused attempt cannot dispatch or clear",
  );
  assert.deepEqual(h.started, [instance("ask#1"), instance("ask#4")]);
  h.engine.askTurnEnded(instance("ask#4"), "other result");
  await repeatedPump;
  await nextTick();
  assert.deepEqual(
    h.nodeEvents("ask#2").filter((event) => event.type === "node-admission"),
    [
      admission("ask#2", "run-capacity"),
      { type: "node-admission", instance: instance("ask#2"), cause: null },
      admission("ask#2", "run-capacity", undefined, 2),
      { type: "node-admission", instance: instance("ask#2", 2), cause: null },
    ],
  );
  assert.deepEqual(h.started.at(-1), instance("ask#2", 2));
  h.engine.askTurnEnded(instance("ask#2", 2), "queued result");
  await queued;
  await nextTick();
  assert.deepEqual(
    h.nodeEvents("ask#3").filter((event) => event.type === "node-admission"),
    [
      admission("ask#3", "actor-fifo", instance("ask#2")),
      admission("ask#3", "actor-fifo", instance("ask#2", 2)),
      { type: "node-admission", instance: instance("ask#3"), cause: null },
    ],
  );
  h.engine.askTurnEnded(instance("ask#3"), "follower result");
  await follower;
  h.engine.complete("done");
});

test("unchanged queue causes are deduplicated without touching usage, node rows or imported cache", async () => {
  const cachedEntries = 8;
  const h = setup(1, {
    importedCache: {
      actors: new Map([
        [
          "cached",
          {
            persona: { name: "cached" },
            transcriptSourceSessionId: "synthetic-cache-session",
            entries: Array.from({ length: cachedEntries }, (_, index) => ({
              inputHash: inputHash("ask#3"),
              result: `cached-${index}`,
              messageBoundary: index + 1,
              stats: { tokens: 7, turns: 1, toolCalls: 1, worldToolCalls: 1 },
            })),
          },
        ],
      ]),
      world: new Map(),
    },
  });
  const active = h.engine.createActor("actor#1", "active");
  const waiting = h.engine.createActor("actor#2", "waiting");
  const cached = h.engine.createActor("actor#3", "cached");
  const first = h.ask("ask#1", active);
  const second = h.ask("ask#2", waiting);
  await nextTick();
  const beforeRun = h.journal.getRun(RUN_ID);
  const beforeNodes = ["ask#1", "ask#2"].map((siteId) => h.journal.getNode(RUN_ID, siteId, 1));
  const beforeActors = h.journal.listActors(RUN_ID);
  for (let index = 0; index < cachedEntries; index++) {
    assert.equal(await h.ask("ask#3", cached), `cached-${index}`);
  }
  assert.deepEqual(h.admissions(), [admission("ask#2", "run-capacity")]);
  assert.deepEqual(h.started, [instance("ask#1")]);
  assert.deepEqual(h.journal.getRun(RUN_ID), beforeRun);
  assert.deepEqual(
    ["ask#1", "ask#2"].map((siteId) => h.journal.getNode(RUN_ID, siteId, 1)),
    beforeNodes,
  );
  assert.deepEqual(h.journal.listActors(RUN_ID), beforeActors);
  assert.equal(
    h.events.some(
      (event) =>
        event.type === "import-cache-closed" ||
        event.type === "usage-updated" ||
        event.type === "node-progress",
    ),
    false,
  );
  assert.ok(h.nodeEvents("ask#3").every((event) => event.type === "node-settled" && event.cached));
  assert.deepEqual(
    h.journal
      .listEvents(RUN_ID)
      .map((stored) => stored.event)
      .filter((event) => event.type === "node-admission"),
    h.admissions(),
    "durable and live admission observations are identical",
  );

  h.engine.askTurnEnded(instance("ask#1"), "first result");
  await first;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#2"), "second result");
  await second;
  h.engine.complete("done");
});

test("cold recovery recalculates causes only after queued admission and preserves a paused attempt", async () => {
  const original = setup(1);
  const serial = original.engine.createActor("actor#1", "serial");
  const other = original.engine.createActor("actor#2", "other");
  original.ask("ask#1", serial);
  original.ask("ask#2", serial);
  original.ask("ask#3", other);
  await nextTick();
  original.engine.pauseAsk(instance("ask#1"));
  await nextTick();
  original.engine.retryAsk(instance("ask#1"));
  original.engine.pauseAsk(instance("ask#1", 2));
  original.engine.stop("user");
  await original.engine.settled;

  const h = setup(1, { journal: original.journal });
  const resumedSerial = h.engine.createActor("actor#1", "serial");
  const resumedOther = h.engine.createActor("actor#2", "other");
  const follower = h.ask("ask#2", resumedSerial);
  const fresh = h.ask("ask#4", resumedSerial);
  assert.deepEqual(h.nodeEvents("ask#2"), [], "recorded hold has not emitted node-queued yet");
  assert.deepEqual(
    h.nodeEvents("ask#4"),
    [],
    "fresh admission still waits for the recorded prefix",
  );
  const first = h.ask("ask#1", resumedSerial);
  const parallel = h.ask("ask#3", resumedOther);
  await nextTick();
  assert.deepEqual(h.started, [instance("ask#3")]);
  assert.deepEqual(
    h.nodeEvents("ask#1").map((event) => event.type),
    ["node-queued", "node-paused"],
  );
  assert.deepEqual(
    h.admissions(),
    [
      admission("ask#2", "actor-fifo", instance("ask#1", 2)),
      admission("ask#4", "actor-fifo", instance("ask#2")),
    ],
    "old run-capacity observations are not restored as current queue facts",
  );

  assert.equal(h.engine.retryAsk(instance("ask#1", 2)), true);
  assert.deepEqual(h.admissions("ask#1"), [admission("ask#1", "run-capacity", undefined, 3)]);
  assert.deepEqual(
    h.admissions("ask#2").at(-1),
    admission("ask#2", "actor-fifo", instance("ask#1", 3)),
  );
  h.engine.askTurnEnded(instance("ask#3"), "parallel result");
  await parallel;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#1", 3), "resumed result");
  await first;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#2"), "follower result");
  await follower;
  await nextTick();
  h.engine.askTurnEnded(instance("ask#4"), "fresh result");
  await fresh;
  h.engine.complete("done");
  const eventCount = h.events.length;
  assert.equal(h.engine.pauseAsk(instance("ask#1", 3)), false);
  assert.equal(h.engine.retryAsk(instance("ask#1", 3)), false);
  assert.equal(h.events.length, eventCount, "a settled run cannot publish more admission events");
});
