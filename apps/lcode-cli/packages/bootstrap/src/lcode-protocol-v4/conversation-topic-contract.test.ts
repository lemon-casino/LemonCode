import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

function title(sequenceNumber: number, text = `Title ${sequenceNumber}`): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    sessionId: "session-one",
    traceId: "trace-one",
    type: SessionEventType.SessionTitleUpdated,
    timestamp: new Date(sequenceNumber),
    sequenceNumber,
    payload: { title: text },
  } as SessionEvent;
}

test("publisher preserves every public callable arity", () => {
  const expected = {
    getSnapshot: 0,
    getWireSnapshotLogicalBytes: 0,
    resolveStableForkCandidate: 1,
    seedConfig: 1,
    seedSharedContextImport: 1,
    seedUsage: 1,
    seedSubagents: 1,
    measureInputAdmissionProjectionBytes: 2,
    getRowsRange: 1,
    getPlans: 0,
    getMessageIdForRow: 1,
    resolveRowActionTarget: 2,
    getMessageIdsForTurnRow: 1,
    isLatestAssistantSegmentRow: 1,
    isLatestRetryAssistantRow: 1,
    isLatestEditableUserRow: 1,
    getTurnIdForRow: 1,
    getDroppedContentStreamEventCount: 0,
    getTurnRewindAnchor: 1,
    ingest: 1,
    rehydrate: 1,
    subscribe: 1,
    subscribeReserved: 1,
    unsubscribe: 2,
    hasSubscription: 2,
    hasSubscribers: 0,
    connectionIdForSubscription: 1,
    reserveFlush: 1,
    flush: 1,
    resyncReserved: 2,
    resync: 1,
  } satisfies Record<Exclude<keyof ConversationTopicPublisher, "topic">, number>;
  assert.equal(ConversationTopicPublisher.length, 2);
  for (const [name, arity] of Object.entries(expected)) {
    const method = ConversationTopicPublisher.prototype[name as keyof typeof expected];
    assert.equal(method.length, arity, name);
  }
});

for (const deliveryProfile of ["continuous", "replayable"] as const) {
  test(`${deliveryProfile}: replacement rollback and recovery supersede preserve reservations`, () => {
    const publisher = new ConversationTopicPublisher("session-one", "epoch-one");
    const initial = publisher.subscribeReserved({
      connectionId: "connection-one",
      deliveryProfile,
    });
    assert.equal(initial.reservation?.commit(), true);
    publisher.ingest(title(1));
    const online = publisher.reserveFlush(initial.ack.subscriptionId);
    assert.ok(online);
    const replacement = publisher.subscribeReserved({
      connectionId: "connection-one",
      deliveryProfile,
    });
    assert.equal(online.commit(), false);
    assert.equal(replacement.rollback(), true);
    assert.equal(publisher.hasSubscription(initial.ack.subscriptionId, "connection-one"), true);
    assert.equal(online.commit(), true);
    publisher.ingest(title(2));
    const superseded = publisher.reserveFlush(initial.ack.subscriptionId);
    assert.ok(superseded);
    const recovery = publisher.resyncReserved(initial.ack.subscriptionId, {
      base: { logEpoch: "epoch-one", seq: 0 },
    });
    assert.equal(superseded.commit(), false);
    assert.equal(recovery?.ack.mode, "resume");
    assert.equal(recovery?.reservation?.frame.fromSeq, 0);
    assert.equal(recovery?.reservation?.frame.toSeq, 2);
    assert.equal(recovery?.reservation?.deliveryKind, "recovery");
    assert.equal(recovery?.reservation?.commit(), true);
  });

  test(`${deliveryProfile}: failed rehydrate never adopts partial projection or loses subscribers`, () => {
    const publisher = new ConversationTopicPublisher("session-one", "epoch-one");
    const initial = publisher.subscribe({ connectionId: "connection-one", deliveryProfile });
    publisher.ingest(title(1, "Original"));
    const before = structuredClone(publisher.getSnapshot());
    const pending = publisher.reserveFlush(initial.ack.subscriptionId);
    assert.ok(pending);
    const failure = new Error("authoritative event failed");
    const malformed = title(3);
    Object.defineProperty(malformed, "type", {
      get: () => {
        throw failure;
      },
    });
    assert.throws(() => publisher.rehydrate([title(2, "Candidate"), malformed]), failure);
    assert.deepEqual(publisher.getSnapshot(), before);
    assert.equal(pending.commit(), true);
    publisher.ingest(title(2));
    const stale = publisher.reserveFlush(initial.ack.subscriptionId);
    assert.ok(stale);
    publisher.rehydrate([title(1, "Recovered")]);
    assert.equal(stale.commit(), false);
    assert.equal(publisher.hasSubscription(initial.ack.subscriptionId, "connection-one"), true);
    assert.equal(
      publisher.reserveFlush(initial.ack.subscriptionId)?.frame.payload.kind,
      "snapshot",
    );
    const oldBase = publisher.subscribeReserved({
      connectionId: "new-connection",
      deliveryProfile,
      base: { logEpoch: "epoch-one", seq: 0 },
    });
    assert.equal(oldBase.ack.mode, "snapshot");
  });
}
