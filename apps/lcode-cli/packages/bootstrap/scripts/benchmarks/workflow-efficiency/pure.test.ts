import assert from "node:assert/strict";
import test from "node:test";
import type { ModelNetworkStatusEvent } from "@lcode/contracts";
import { InMemoryJournalStore, WorkflowEngine, WorkflowError } from "@lcode/dynamic-workflow";
import {
  PAIR_ORDERS,
  TASK_IDS,
  canonical,
  fixtureFingerprints,
  integrationPrompt,
  makeFixture,
  newEarlyParallel,
  oldSerial,
  validResult,
  type TaskId,
} from "./fixtures.js";
import {
  ArmMetrics,
  pairedSummary,
  sanitizeUsage,
  usageSummary,
  type ArmResult,
} from "./metrics.js";

test("five synthetic fixtures have strict validators, stable prompts and fixed AB/BA order", () => {
  assert.deepEqual(PAIR_ORDERS, ["AB", "BA", "AB", "BA", "AB"]);
  for (let pair = 1; pair <= 5; pair += 1) {
    const fixture = makeFixture(pair);
    for (const task of TASK_IDS) {
      assert.equal(validResult(fixture, task, fixture.expected[task]), true);
      assert.equal(validResult(fixture, task, { ...fixture.expected[task], extra: 1 }), false);
      assert.equal(validResult(fixture, task, { task }), false);
    }
    assert.equal(fixtureFingerprints(fixture).length, 3);
    assert.equal(canonical(makeFixture(pair)), canonical(fixture));
    assert.throws(() => integrationPrompt(fixture, {}, fixture.expected.B));
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("old starts B only after A; new starts both before either delivery, C waits for both", async () => {
  const fixture = makeFixture(1);
  for (const strategy of [oldSerial, newEarlyParallel]) {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const calls: TaskId[] = [];
    const finished = strategy(
      {
        ask(task) {
          calls.push(task);
          return task === "A"
            ? a.promise
            : task === "B"
              ? b.promise
              : Promise.resolve(fixture.expected.C);
        },
      },
      fixture,
    );
    assert.deepEqual(calls, strategy === oldSerial ? ["A"] : ["A", "B"]);
    a.resolve(fixture.expected.A);
    await Promise.resolve();
    assert.deepEqual(calls, ["A", "B"]);
    b.resolve(fixture.expected.B);
    assert.deepEqual(await finished, fixture.expected.C);
    assert.deepEqual(calls, ["A", "B", "C"]);
  }
});

test("both strategies send identical prompts through the actual public engine, without cached results", async () => {
  const fixture = makeFixture(2);
  const observed: Record<string, string>[] = [];
  for (const strategy of [oldSerial, newEarlyParallel]) {
    const prompts: Record<string, string> = {};
    const metrics = new ArmMetrics(performance.now());
    const journal = new InMemoryJournalStore();
    let engine!: WorkflowEngine;
    engine = new WorkflowEngine({
      runId: "synthetic-test",
      caps: { maxConcurrency: 2 },
      askSpecs: new Map(TASK_IDS.map((task) => [task, { typed: true, schema: task }])),
      validate: (schema, value) =>
        validResult(fixture, schema as TaskId, value)
          ? []
          : [{ path: "$", expected: "fixture", got: "mismatch" }],
      driver: {
        journal,
        emit: (event) => metrics.engine(event),
        createActorSession: async (actor) => ({ id: actor.siteId }),
        startAsk: (_session, instance, message) => {
          const task = instance.siteId as TaskId;
          prompts[task] = message.instructions;
          queueMicrotask(() => {
            metrics.task(task).validated = true;
            engine.askSubmitAttempted(instance, fixture.expected[task]);
          });
        },
        respondToSubmit: (_instance, verdict) => assert.equal(verdict.kind, "accept"),
        cancelAsk: () => {},
        executeWorldRead: async () => {
          throw new WorkflowError("DriverError", "disabled");
        },
      },
    });
    const actors = Object.fromEntries(
      TASK_IDS.map((task) => [task, engine.createActor(`actor-${task}`, task)]),
    );
    const value = await strategy(
      { ask: (task, prompt) => engine.ask(task, actors[task]!, prompt) },
      fixture,
    );
    engine.complete(value);
    assert.equal((await engine.settled).status, "completed");
    assert.equal(metrics.snapshot().acceptedTasks, 3);
    assert.equal(metrics.snapshot().cachedNodes, 0);
    assert.notEqual(metrics.snapshot().ttfdMs, null);
    observed.push(prompts);
  }
  assert.deepEqual(observed[0], observed[1]);
});

test("usage preserves missing fields and does not double-count reasoning tokens", () => {
  assert.equal(sanitizeUsage(undefined), null);
  assert.equal(sanitizeUsage({}), null);
  const usage = sanitizeUsage({
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 30,
    totalTokens: 150,
  });
  const summary = usageSummary([usage, null]);
  assert.equal(summary.knownSums.totalTokens, 150);
  assert.equal(summary.knownSums.outputTokens, 50);
  assert.equal(summary.knownSums.reasoningTokens, 30);
  assert.equal(summary.completeTotals.totalTokens, null);
  assert.equal(summary.knownSums.cacheReadTokens, null);
});

test("TTFD only follows validated settlement; retry schedule is not actual sleep; status payload is allowlisted", () => {
  let now = 0;
  const metrics = new ArmMetrics(0, () => now);
  const event = (type: string, extra = {}) =>
    ({
      type,
      requestId: "private-request",
      task: "A",
      attempt: 1,
      baseURL: "https://private.invalid",
      requestHeaders: { authorization: "private-secret" },
      message: "private-error",
      ...extra,
    }) as unknown as ModelNetworkStatusEvent;
  now = 10;
  metrics.network("A", event("model_request_started"));
  now = 20;
  metrics.task("A").firstTextAtMs = now;
  assert.equal(metrics.snapshot().ttfdMs, null);
  metrics.network("A", event("model_retry_scheduled", { delayMs: 2000, reason: "network_error" }));
  now = 30;
  metrics.network(
    "A",
    event("model_request_completed", { durationMs: 25, usage: { totalTokens: 10 } }),
  );
  metrics.task("A").validated = true;
  metrics.engine({ type: "node-settled", instance: { siteId: "A", ordinal: 1 }, outcome: "ok" });
  const output = metrics.snapshot();
  assert.equal(output.ttfdMs, 30);
  assert.equal(output.requests[0]?.observedRequestDurationMs, 20);
  assert.equal(output.requests[0]?.adapterAttemptDurationMs, 25);
  assert.equal(output.backoff.actualSleepMs, null);
  assert.equal(output.backoff.byReason.network_error?.scheduledDelayMs, 2000);
  assert.equal(JSON.stringify(output).includes("private"), false);
});

test("paired statistics retain failures and slower optimized samples", () => {
  const arm = (pair: number, label: "A" | "B", total: number, success: boolean): ArmResult => ({
    pair,
    arm: label,
    success,
    failureReason: success ? null : "timeout",
    engineStatus: "completed",
    cleanupCompleted: true,
    preparation: {},
    metrics: { ...new ArmMetrics(0, () => total).snapshot(), ttfdMs: total / 2 },
  });
  const summary = pairedSummary([
    arm(1, "A", 100, true),
    arm(1, "B", 200, true),
    arm(2, "A", 20, false),
    arm(2, "B", 10, true),
  ]);
  assert.equal(summary.arms, 4);
  assert.equal(summary.successfulPairs, 1);
  assert.equal(summary.totalSpeedup?.median, 0.5);
  assert.equal(summary.pairs[1]?.totalSpeedup, null);
});
