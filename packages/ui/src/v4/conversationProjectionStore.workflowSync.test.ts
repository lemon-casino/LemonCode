import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type V4ConversationSubscribeResult,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationProjectionStore } from "./conversationProjectionStore.js";
import type { ConversationTransport } from "./transport.js";

const topic = "conversation/workflow-parent";
function snapshot(seq = 1): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "workflow-parent",
    logEpoch: "epoch",
    seq,
    revision: seq,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: Object.fromEntries(
      [
        "fork",
        "compact",
        "switchModelConfig",
        "setFollowupMode",
        "queueEdit",
        "sendQueuedNow",
        "pauseGoal",
        "resumeGoal",
      ].map((key) => [key, { allowed: true }]),
    ),
    inputRouting: { mode: "enqueue" },
    config: { provider: "fixture", model: "fixture", thought: "", followupMode: "queue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    rows: { window: [], totalCount: 0, firstRowId: null },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workflowRuns: {
      revision: seq,
      runs: [
        {
          runId: "run",
          status: "running",
          actors: [],
          usage: { spentTokens: 0, nodesUsed: 1 },
          lastEventSequence: seq,
          nodes: [
            {
              siteId: "ask#1",
              ordinal: 1,
              phase: "executing",
              activity: {
                kind: "model",
                observedAt: 1_000,
                since: 900,
                requestsCompleted: 0,
                toolCalls: 0,
              },
            },
          ],
        },
      ],
    },
  });
}
function frame(subscriptionId: string, seq: number, from?: number): ConversationTopicFrame {
  return {
    topic,
    subscriptionId,
    fromSeq: from ?? 0,
    toSeq: seq,
    sentAt: 5_000,
    payload:
      from === undefined
        ? { kind: "snapshot", snapshot: snapshot(seq) }
        : { kind: "deltas", deltas: [] },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  let next = 0;
  const recovery = deferred<V4ConversationSubscribeResult>();
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: `sub-${++next}`, mode: "snapshot", logEpoch: "epoch" },
    }),
    activate: () => {},
    resync: () => recovery.promise,
    unsubscribe: async () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;
  const store = new ConversationProjectionStore(topic, transport);
  return { store, recovery, transport };
}

for (const profile of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`${profile}: ACK is not a current projection; initial and recovery are display-only syncing`, async (t) => {
    const { store, recovery } = harness();
    t.after(() => store.close());
    const published: { syncing: boolean | undefined; seq: number | undefined }[] = [];
    store.subscribe(() =>
      published.push({ syncing: store.getState().syncing, seq: store.getState().snapshot?.seq }),
    );
    await store.connect();
    assert.equal(store.getState().status, "live", "existing lifecycle is unchanged");
    assert.equal(store.getState().syncing, true, "ACK before initial cannot say current");
    store.handleFrame(frame("old-sub", 9), { deliveryKind: "initial" });
    assert.equal(store.getState().snapshot, null, "stale subscription remains fenced");
    store.handleFrame(frame("sub-1", 1), { deliveryKind: "initial" });
    assert.equal(store.getState().syncing, false);
    const initial = store.getState().snapshot;
    store.handleFrame(frame("sub-1", 5, 4), { deliveryKind: "online" });
    assert.equal(store.getState().status, "live");
    assert.equal(
      store.getState().syncing,
      true,
      "same-sub gap keeps the old projection but marks it stale",
    );
    assert.equal(store.getState().snapshot, initial);
    recovery.resolve({
      ack: {
        subscriptionId: "sub-1",
        mode: profile === "desktop-continuous" ? "snapshot" : "resume",
        logEpoch: "epoch",
      },
    });
    await Promise.resolve();
    assert.equal(store.getState().syncing, true, "recovery ACK also waits for its frame");
    store.handleFrame(profile === "desktop-continuous" ? frame("sub-1", 5) : frame("sub-1", 5, 1), {
      deliveryKind: "recovery",
    });
    assert.equal(store.getState().syncing, false);
    assert.equal(store.getState().snapshot?.seq, 5);
    assert.equal(
      store.getState().snapshot?.workflowRuns?.runs[0]?.nodes[0]?.activity?.observedAt,
      1_000,
    );
    const stable = store.getState();
    assert.equal(store.getState(), stable, "getSnapshot retains referential stability");
    assert.ok(published.some((entry) => entry.syncing === true && entry.seq === 1));
    assert.equal(published.at(-1)?.syncing, false, "private recovery completion notifies React");
    assert.ok(
      published.every((entry) => entry.seq !== undefined || entry.syncing !== false),
      "no transient current state before first frame",
    );
  });
}

test("recovery frame before ACK and aligned resume remain syncing until the existing flight completes", async (t) => {
  const { store, recovery } = harness();
  t.after(() => store.close());
  await store.connect();
  store.handleFrame(frame("sub-1", 1), { deliveryKind: "initial" });
  store.recoverFromStaleAuthority();
  store.handleFrame(frame("sub-1", 1, 1), { deliveryKind: "recovery" });
  assert.equal(store.getState().syncing, true);
  recovery.resolve({ ack: { subscriptionId: "sub-1", mode: "resume", logEpoch: "epoch" } });
  await Promise.resolve();
  assert.equal(store.getState().syncing, false);
});

test("new subscribe ACK and old frames cannot temporarily revive historical activity", async (t) => {
  const { store } = harness();
  t.after(() => store.close());
  await store.connect();
  store.handleFrame(frame("sub-1", 1), { deliveryKind: "initial" });
  const previous = store.getState().snapshot;
  const observed: boolean[] = [];
  store.subscribe(() => observed.push(store.getState().syncing === true));
  await store.connect();
  assert.equal(store.getState().snapshot, previous);
  assert.equal(store.getState().syncing, true);
  assert.ok(observed.every(Boolean));
  store.handleFrame(frame("sub-1", 9), { deliveryKind: "initial" });
  assert.equal(store.getState().snapshot, previous);
  store.handleFrame(frame("sub-2", 2), { deliveryKind: "initial" });
  assert.equal(store.getState().syncing, false);
});

test("recovery failure and close retain their existing stale statuses, not an active syncing flag", async () => {
  const { store, recovery } = harness();
  await store.connect();
  store.handleFrame(frame("sub-1", 1), { deliveryKind: "initial" });
  store.recoverFromStaleAuthority();
  recovery.reject(new Error("fixture recovery failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().status, "error");
  assert.equal(store.getState().syncing, false);
  await store.close();
  assert.equal(store.getState().status, "closed");
  assert.equal(store.getState().syncing, false);
});
