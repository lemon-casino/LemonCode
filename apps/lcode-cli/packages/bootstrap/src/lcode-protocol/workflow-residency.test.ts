import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "@lcode/core";
import { createSessionId, createInMemorySessionEventStore } from "@lcode/contracts";
import { readAppResidencySnapshot } from "../app/app-residency.js";
import { createRunServiceLifecycle } from "../app/dynamic-workflow-run-lifecycle.js";
import type { RunRegistryEntry } from "../app/dynamic-workflow-run-observation.js";
import type { RunSettlement } from "@lcode/dynamic-workflow";
import { createSessionResidentPoolHost } from "./session-residency.js";
import { SessionResidentPool } from "./session-resident-pool.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

function fixture() {
  const sessionId = createSessionId();
  const runtime = new AgentRuntime(
    sessionId,
    {
      workingDirectory: "C:/fixture",
      modelSelection: { providerId: "fixture", modelId: "fixture" },
      mode: "yolo",
      mcp: { enabled: false },
      memory: { enabled: false },
      titleGeneration: { enabled: false },
    },
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => {
        throw new Error("No model should start");
      },
    },
  );
  const runs = new Map<string, RunRegistryEntry>();
  const lifecycle = createRunServiceLifecycle({
    runs,
    parentSessionId: sessionId,
    journal: { getRun: () => undefined },
    registerResidencyBlockingWork: (work) => runtime.retainSessionStoreDependentCloseWork(work),
  });
  const effects: string[] = [];
  const app = {
    runtime,
    readResidencySnapshot: () => readAppResidencySnapshot(runtime, lifecycle),
    close: async () => {
      effects.push("close");
    },
  };
  const record = {
    app,
    persistence: "immediate",
    updatedAt: 0,
    unsubscribe: () => effects.push("unsubscribe"),
    eventStore: createInMemorySessionEventStore(),
  } as unknown as LCodeProtocolSessionRecord;
  const context = {
    sessions: new Map([[sessionId, record]]),
    v4Interactions: { hasPendingForSession: () => false },
    v4Gateway: {
      hasResidencyBlockingCommands: () => false,
      hasConversationSubscribers: () => false,
      assertSessionRuntimeDeactivatable: () => {},
      deactivateSession: () => effects.push("projection"),
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const host = createSessionResidentPoolHost(context);
  const pool = new SessionResidentPool(host, {
    idleTimeoutMs: 0,
    highWaterCount: 0,
    targetCount: 0,
  });
  function launch(id: string) {
    let settle!: (result: RunSettlement) => void;
    const launched = new Promise<RunSettlement>((resolve) => {
      settle = resolve;
    });
    const entry: RunRegistryEntry = {
      controller: new AbortController(),
      cwd: "C:/fixture",
      scriptText: "return 1",
      startedAt: new Date(),
      settlement: launched,
    };
    runs.set(id, entry);
    entry.settlement = lifecycle.trackSettlement(id, entry, launched);
    return { entry, settle };
  }
  return { runtime, lifecycle, launch, pool, host, context, sessionId, record, effects };
}

test("synchronous close event cannot reenter admission before the deactivation gate exists", async () => {
  const ids = ["idle"];
  let releaseClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let admitted = false;
  let reentrant!: Promise<void>;
  const pool = new SessionResidentPool(
    {
      listSessionIds: () => ids,
      readResidencyFacts: () => ({
        persisted: true,
        hasResidencyBlockingWork: false,
        hasPendingInteractions: false,
        hasQueuedCommands: false,
        hasSubscribers: false,
        hasLegacySubscriber: false,
        lastActivityAt: 0,
      }),
      deactivate: () => {
        reentrant = pool.acquireOperation("idle").then((release) => {
          admitted = true;
          release();
        });
        ids.length = 0;
        return { status: "started", completion: closing };
      },
    },
    { idleTimeoutMs: 0 },
  );
  pool.rebalance();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  releaseClose();
  await reentrant;
  assert.equal(admitted, true);
});

test("actual Core and workflow lifecycle retain two live runs across TTL and high water", async () => {
  const f = fixture();
  const first = f.launch("first");
  const second = f.launch("second");
  f.pool.rebalance();
  assert.deepEqual(f.effects, []);
  assert.equal(first.entry.controller.signal.aborted, false);
  first.settle({ status: "completed", artifact: 1 });
  await first.entry.settlement;
  f.pool.rebalance();
  assert.deepEqual(f.effects, []);
  assert.equal(second.entry.controller.signal.aborted, false);
  second.settle({ status: "completed", artifact: 2 });
  await second.entry.settlement;
  await f.runtime.drainSessionStoreDependentCloseWork();
  f.pool.rebalance();
  await f.pool.waitForDeactivation(f.sessionId);
  assert.deepEqual(f.effects, ["unsubscribe", "projection", "close"]);
});

test("deactivation checks new blockers and exact App before any mutation", () => {
  const f = fixture();
  const expected = f.host.readResidencyFacts(f.sessionId)!;
  f.record.app = { ...f.record.app };
  assert.equal(f.host.deactivate(f.sessionId, expected).status, "blocked");
  assert.deepEqual(f.effects, []);
  const fresh = f.host.readResidencyFacts(f.sessionId)!;
  f.record.activeAbortController = new AbortController();
  assert.equal(f.host.deactivate(f.sessionId, fresh).status, "blocked");
  assert.deepEqual(f.effects, []);
});

test("blocked deactivation does not consume resident capacity or install a false gate", async () => {
  const ids = ["blocked", "idle"];
  const decisions: number[] = [];
  const facts = {
    persisted: true,
    hasResidencyBlockingWork: false,
    hasPendingInteractions: false,
    hasQueuedCommands: false,
    hasSubscribers: false,
    hasLegacySubscriber: false,
    lastActivityAt: 0,
  };
  const pool = new SessionResidentPool(
    {
      listSessionIds: () => ids,
      readResidencyFacts: () => facts,
      deactivate: (id) => {
        if (id === "blocked") return { status: "blocked" };
        ids.splice(ids.indexOf(id), 1);
        return { status: "started", completion: Promise.resolve() };
      },
      onDeactivated: (_id, decision) => {
        decisions.push(decision.residentCountBefore);
      },
    },
    { targetCount: 1, highWaterCount: 1 },
  );
  pool.rebalance();
  await pool.waitForDeactivation("idle");
  assert.deepEqual(ids, ["blocked"]);
  assert.deepEqual(decisions, [2]);
});
