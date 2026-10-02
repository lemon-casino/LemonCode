import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  TopicWireFrameAssembler,
  type ConversationTopicFrame,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

const instance = { siteId: "ask#one", ordinal: 1 };
const activity = {
  kind: "model",
  observedAt: 1_500,
  since: 1_500,
  requestsCompleted: 2,
  toolCalls: 3,
  requestId: "request-current",
  lastRequestCompletedAt: 1_400,
};

function facts() {
  let sequence = 0;
  return (eventType: string, payload: Record<string, unknown>, occurredAt = 1_000) =>
    ({
      id: `event-${++sequence}`,
      sessionId: "parent-session",
      traceId: "trace-one",
      turnId: "turn-one",
      timestamp: new Date(9_000 + sequence),
      sequenceNumber: sequence,
      type: SessionEventType.DynamicWorkflowRunProgress,
      payload: { runId: "run-one", sequence, eventType, payload, occurredAt },
    }) as SessionEvent;
}

function transmit(reservation: TopicFrameReservation<ConversationTopicFrame>, fragmented: boolean) {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const wires = encodeTopicWireFrames(reservation.frame, {
    ...reservation,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    ...(fragmented ? { maxPhysicalFrameBytes: 2_048 } : {}),
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  });
  assert.equal(wires[0]?.kind, fragmented ? "fragment" : "complete");
  const frames = wires.flatMap((wire) => assembler.accept(wire, 100));
  assert.equal(frames.length, 1);
  assert.equal(reservation.commit(), true);
  const complete = frames[0];
  assert.ok(complete?.kind === "complete");
  return complete.frame;
}

for (const profile of ["continuous", "replayable"] as const) {
  for (const fragmented of [false, true]) {
    test(`${profile} ${fragmented ? "分片" : "完整帧"}活动与首次退避在线/恢复保持相同源事实`, () => {
      const event = facts();
      const publisher = new ConversationTopicPublisher("parent-session", "epoch-one");
      const subscribed = publisher.subscribeReserved({
        connectionId: "connection-one",
        deliveryProfile: profile,
      });
      assert.ok(subscribed.reservation);
      const initial = transmit(subscribed.reservation, fragmented);
      assert.ok(initial.payload.kind === "snapshot");
      publisher.ingest(event("run-started", {}));
      publisher.ingest(event("node-queued", { instance, kind: "ask" }));
      for (let ordinal = 1; ordinal <= 12; ordinal++) {
        publisher.ingest(
          event("actor-created", {
            actor: { siteId: "actor#parallel", ordinal },
            name: `独立调查 ${ordinal}`,
          }),
        );
      }
      publisher.ingest(
        event(
          "node-admission",
          {
            instance,
            cause: "actor-fifo",
            blockedBy: { siteId: "ask#prior", ordinal: 1 },
          },
          1_100,
        ),
      );
      const queuedFlush = publisher.reserveFlush(subscribed.ack.subscriptionId);
      assert.ok(queuedFlush);
      const queuedFrame = transmit(queuedFlush, fragmented);
      assert.ok(queuedFrame.payload.kind === "deltas");
      const queuedClient = applyConversationDeltas(
        initial.payload.snapshot,
        queuedFrame.payload.deltas,
      );
      const queue = queuedClient.workflowRuns?.runs[0]?.nodes[0]?.queue;
      assert.deepEqual(queue, {
        cause: "actor-fifo",
        since: 1_100,
        blockedBy: { siteId: "ask#prior", ordinal: 1 },
      });
      const queuedResync = publisher.resyncReserved(subscribed.ack.subscriptionId, {
        base: null,
        forceSnapshot: true,
      });
      assert.ok(queuedResync?.reservation);
      const queuedRecovery = transmit(queuedResync.reservation, fragmented);
      assert.ok(queuedRecovery.payload.kind === "snapshot");
      assert.deepEqual(queuedRecovery.payload.snapshot.workflowRuns, queuedClient.workflowRuns);
      publisher.ingest(event("node-dispatched", { instance }));
      publisher.ingest(event("node-activity", { instance, activity }, 1_600));
      publisher.ingest(
        event(
          "node-waiting",
          {
            instance,
            cause: "backoff",
            reason: "network_error",
            attempt: 2,
            delayMs: 2_000,
          },
          2_000,
        ),
      );
      const online = publisher.reserveFlush(subscribed.ack.subscriptionId);
      assert.ok(online);
      const frame = transmit(online, fragmented);
      assert.ok(frame.payload.kind === "deltas");
      const client = applyConversationDeltas(queuedRecovery.payload.snapshot, frame.payload.deltas);
      const node = client.workflowRuns?.runs[0]?.nodes[0];
      assert.deepEqual(node?.activity, activity);
      assert.equal(node?.wait?.nextRetryAt, 4_000);
      assert.equal(node?.wait?.attempt, 2);
      assert.equal(node?.settledAt, undefined);
      assert.equal(node?.queue, undefined);
      conversationSnapshotSchema.parse(client);
      const resync = publisher.resyncReserved(subscribed.ack.subscriptionId, {
        base: null,
        forceSnapshot: true,
      });
      assert.ok(resync?.reservation);
      const recovered = transmit(resync.reservation, fragmented);
      assert.ok(recovered.payload.kind === "snapshot");
      assert.deepEqual(recovered.payload.snapshot.workflowRuns, client.workflowRuns);
      publisher.ingest(event("node-executing", { instance }, 4_000));
      publisher.ingest(event("node-settled", { instance, outcome: "ok" }, 5_000));
      const settled = publisher.resyncReserved(subscribed.ack.subscriptionId, {
        base: null,
        forceSnapshot: true,
      });
      assert.ok(settled?.reservation);
      const finished = transmit(settled.reservation, fragmented);
      assert.ok(finished.payload.kind === "snapshot");
      const done = finished.payload.snapshot.workflowRuns?.runs[0]?.nodes[0];
      assert.equal(done?.wait, undefined);
      assert.equal(done?.settledAt, 5_000);
      assert.equal(done?.activity?.observedAt, 1_500);
    });
  }
}

test("冷投影按原事件重建活动，旧记录缺活动仍兼容", () => {
  const event = facts();
  const events = [
    event("run-started", {}),
    event("node-queued", { instance, kind: "ask" }),
    event("node-activity", { instance, activity }),
    event("node-settled", { instance, outcome: "ok" }, 4_000),
  ];
  const live = new ProductProjection("parent-session", "epoch-one");
  const cold = new ProductProjection("parent-session", "epoch-two");
  for (const item of events) {
    live.applyEvent(item);
    cold.applyEvent({ ...item, timestamp: new Date(100_000) } as SessionEvent);
  }
  assert.deepEqual(cold.getSnapshot().workflowRuns, live.getSnapshot().workflowRuns);
  const old = new ProductProjection("old-session", "epoch-old");
  conversationSnapshotSchema.parse(old.getSnapshot());
});
