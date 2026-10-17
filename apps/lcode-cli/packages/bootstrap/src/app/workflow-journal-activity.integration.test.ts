import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import {
  WorkflowEngine,
  type AskActivity,
  type InstanceRef,
  type RunEvent,
  type WorkflowDriver,
} from "@lcode/dynamic-workflow";
import { createActivityEmitter } from "./workflow-driver-activity-emitter.js";

const EPOCH = 1_700_000_000_000;
const ACTIVITY_INTERVAL_MS = 1_000;

test("a delayed workflow activity survives a competing SQLite writer and the ask completes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-journal-activity-"));
  const dbPath = join(directory, "sessions.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  const competing = new DatabaseSync(dbPath);
  const lease = await store.acquireWorkflowExecutionOwner({
    parentSessionId: "fixture-parent",
    workspaceKey: "fixture-workspace",
  });
  const events: RunEvent[] = [];
  let instance: InstanceRef | undefined;
  const driver: WorkflowDriver = {
    journal: lease.journal,
    emit: (event) => events.push(event),
    createActorSession: async () => ({ id: "fixture-actor-session" }),
    startAsk: (_session, current) => {
      instance = current;
    },
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => undefined,
  };
  const engine = new WorkflowEngine({
    runId: "fixture-run",
    parentSessionId: "fixture-parent",
    driver,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map([["ask#1", { typed: true }]]),
    validate: () => [],
  });
  const actor = engine.createActor("actor#1", "fixture-actor");
  const result = engine.ask("ask#1", actor, "fixture instructions");
  void result.catch(() => {});
  let now = EPOCH;
  let flush: (() => void) | undefined;
  const emitter = createActivityEmitter({
    live: () => instance,
    emit: (current, activity) => engine.askActivity(current, activity),
    clock: {
      now: () => now,
      schedule: (callback) => {
        flush = callback;
        return () => {
          flush = undefined;
        };
      },
    },
  });
  t.after(async () => {
    emitter.clear();
    try {
      engine.stop("user");
      await result.catch(() => {});
      lease.release();
    } finally {
      competing.close();
      store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(instance);
  const activity: AskActivity = {
    kind: "model",
    observedAt: now,
    since: now,
    requestsCompleted: 0,
    toolCalls: 0,
  };
  emitter.offer(instance, activity, true);
  const readRun = lease.journal.getRun.bind(lease.journal);
  let interleaved = false;
  let competingError: unknown;
  const competingWrite = () =>
    competing.exec(
      "insert into local_setting (scope, scope_id, namespace, key, value, schema_version, time_created, time_updated) values ('session', 'other-parent', 'fixture', 'noise', 'fixture', 1, 0, 0)",
    );
  // 通过正式 lease 的只读 seam 安排真实连接交错，复现日志中的 timer → engine → journal 链路。
  lease.journal.getRun = (id) => {
    const record = readRun(id);
    if (!interleaved) {
      interleaved = true;
      try {
        competingWrite();
      } catch (error) {
        competingError = error;
      }
    }
    return record;
  };
  now++;
  const latest = { ...activity, observedAt: now, requestsCompleted: 1 };
  emitter.offer(instance, latest, false);
  assert.ok(flush, "second activity uses the actual delayed callback");
  now += ACTIVITY_INTERVAL_MS;
  assert.doesNotThrow(flush);
  assert.equal((competingError as { errcode?: number })?.errcode, 5);
  const activityEvents = events.filter((event) => event.type === "node-activity");
  const persisted = lease.journal.listEvents("fixture-run");
  assert.equal(activityEvents.length, 2);
  assert.deepEqual(activityEvents.at(-1), persisted.at(-1)?.event);
  assert.deepEqual(activityEvents.at(-1)?.activity, latest);
  assert.deepEqual(
    persisted.map((event) => event.sequence),
    persisted.map((_, index) => index),
  );
  competingWrite();
  engine.askSubmitAttempted(instance, { done: true });
  assert.deepEqual(await result, { done: true });
  engine.complete("fixture completed");
  assert.equal(lease.journal.getRun("fixture-run")?.status, "completed");
});
