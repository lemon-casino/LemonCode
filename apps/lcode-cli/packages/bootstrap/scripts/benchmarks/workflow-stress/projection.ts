import assert from "node:assert/strict";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import type { RunEvent, StoredEvent } from "@lcode/dynamic-workflow";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  TopicWireFrameAssembler,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationTopicPublisher } from "../../../dist/lcode-protocol-v4/conversation-topic-publisher.js";
import type { TopicFrameReservation } from "../../../dist/lcode-protocol-v4/topic-frame-reservation.js";

export function createProjectionPipeline(runId: string) {
  // 使用磁盘上已验证 dist，避免并行拆分中的 source projection 改变测试装配；hash 由 runner 记录。
  const publisher = new ConversationTopicPublisher("synthetic-parent", "synthetic-epoch");
  const clients = (["continuous", "replayable"] as const).map((profile) => {
    const subscribed = publisher.subscribeReserved({
      connectionId: profile,
      deliveryProfile: profile,
    });
    assert.ok(subscribed.reservation);
    return {
      profile,
      id: subscribed.ack.subscriptionId,
      snapshot: publisher.getSnapshot(),
      assembler: new TopicWireFrameAssembler(conversationTopicFrameSchema),
      reservation: subscribed.reservation,
      logicalFrames: 0,
      physicalFrames: 0,
      logicalBytes: 0,
      cliNdjsonBytes: 0,
      channelSocketBytes: 0,
      mobileRelayBytes: 0,
      recoveryCount: 0,
      staleReservationsRejected: 0,
    };
  });
  type Client = (typeof clients)[number];
  let sourceSequence = 0;
  let projectionUpdates = 0;
  let projectionUpdateBytes = 0;
  let maxNodes = 0;
  let maxActiveNodes = 0;
  let truncatedObserved = false;
  let staleEventsRejected = 0;

  const receive = (client: Client, reservation: TopicFrameReservation<ConversationTopicFrame>) => {
    const frame = reservation.frame;
    client.logicalFrames++;
    client.logicalBytes += Buffer.byteLength(JSON.stringify(frame));
    const wires = encodeTopicWireFrames(frame, {
      ...reservation,
      topic: frame.topic,
      subscriptionId: frame.subscriptionId,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
    for (const wire of wires) {
      client.physicalFrames++;
      const bytes = measureTopicNotificationEnvelopeBytes(wire);
      client.cliNdjsonBytes += bytes.cliNdjsonBytes;
      client.channelSocketBytes += bytes.channelSocketBytes;
      client.mobileRelayBytes += bytes.mobileRelayBytes;
      for (const complete of client.assembler.accept(wire, Date.now())) {
        assert.equal(complete.kind, "complete");
        if (complete.kind !== "complete") continue;
        const payload = complete.frame.payload;
        if (payload.kind === "snapshot") client.snapshot = payload.snapshot;
        else {
          assert.equal(complete.frame.fromSeq, client.snapshot.seq);
          client.snapshot = {
            ...applyConversationDeltas(client.snapshot, payload.deltas),
            seq: complete.frame.toSeq,
          };
        }
      }
    }
    assert.equal(reservation.commit(), true);
  };
  for (const client of clients) receive(client, client.reservation);

  function envelope(event: RunEvent, sequence: number, occurredAt: number): SessionEvent {
    const { type, ...payload } = event;
    return {
      id: `parent-${++sourceSequence}`,
      sessionId: "synthetic-parent",
      traceId: "synthetic-trace",
      type: SessionEventType.DynamicWorkflowRunProgress,
      sequenceNumber: sourceSequence,
      timestamp: new Date(),
      payload: { runId, sequence, eventType: type, payload, occurredAt },
    } as SessionEvent;
  }

  return {
    consume(event: RunEvent, stored: StoredEvent) {
      const revision = publisher.getSnapshot().workflowRuns?.revision;
      assert.equal(typeof stored.timeCreated, "number");
      publisher.ingest(envelope(event, stored.sequence + 1, stored.timeCreated!));
      const state = publisher.getSnapshot().workflowRuns;
      if (state?.revision !== revision) {
        projectionUpdates++;
        projectionUpdateBytes += Buffer.byteLength(
          JSON.stringify({ op: "state.updated", patch: { workflowRuns: state } }),
        );
      }
      const run = state?.runs[0];
      maxNodes = Math.max(maxNodes, run?.nodes.length ?? 0);
      maxActiveNodes = Math.max(
        maxActiveNodes,
        run?.nodes.filter((node) => node.phase !== "settled").length ?? 0,
      );
      truncatedObserved ||= run?.truncated === true;
      assert.ok(maxNodes <= 256);
    },
    flush(profile?: Client["profile"]) {
      for (const client of clients) {
        if (profile !== undefined && client.profile !== profile) continue;
        const reserved = publisher.reserveFlush(client.id);
        if (reserved !== null) receive(client, reserved);
      }
    },
    recover() {
      for (const client of clients) {
        const stale = publisher.reserveFlush(client.id);
        const recovery = publisher.resyncReserved(client.id, {
          base: { logEpoch: client.snapshot.logEpoch, seq: client.snapshot.seq },
          forceSnapshot: client.profile === "continuous",
        });
        assert.ok(recovery);
        assert.equal(recovery.ack.subscriptionId, client.id);
        if (stale !== null) {
          assert.equal(stale.commit(), false);
          client.staleReservationsRejected++;
        }
        if (recovery.reservation !== null) receive(client, recovery.reservation);
        assert.deepEqual(client.snapshot.workflowRuns, publisher.getSnapshot().workflowRuns);
        client.recoveryCount++;
      }
    },
    stale() {
      const before = publisher.getSnapshot().workflowRuns;
      publisher.ingest(
        envelope({ type: "run-started", runId, caps: { maxConcurrency: 1 } }, 1, Date.now()),
      );
      assert.deepEqual(publisher.getSnapshot().workflowRuns, before);
      staleEventsRejected++;
    },
    snapshot: (): ConversationSnapshot => publisher.getSnapshot(),
    verifyActive(expected: number) {
      const run = publisher.getSnapshot().workflowRuns?.runs[0];
      assert.equal(run?.nodes.filter((node) => node.phase !== "settled").length, expected);
    },
    counters() {
      return {
        projectionUpdates,
        projectionUpdateBytes,
        clients: clients.map(
          ({
            profile,
            logicalFrames,
            physicalFrames,
            logicalBytes,
            cliNdjsonBytes,
            channelSocketBytes,
            mobileRelayBytes,
          }) => ({
            profile,
            logicalFrames,
            physicalFrames,
            logicalBytes,
            cliNdjsonBytes,
            channelSocketBytes,
            mobileRelayBytes,
          }),
        ),
      };
    },
    summary() {
      for (const client of clients)
        assert.deepEqual(client.snapshot.workflowRuns, publisher.getSnapshot().workflowRuns);
      return {
        projectionUpdates,
        projectionUpdateBytes,
        maxNodes,
        maxActiveNodes,
        truncatedObserved,
        staleEventsRejected,
        clients: clients.map(
          ({
            profile,
            logicalFrames,
            physicalFrames,
            logicalBytes,
            cliNdjsonBytes,
            channelSocketBytes,
            mobileRelayBytes,
            recoveryCount,
            staleReservationsRejected,
          }) => ({
            profile,
            logicalFrames,
            physicalFrames,
            logicalBytes,
            cliNdjsonBytes,
            channelSocketBytes,
            mobileRelayBytes,
            recoveryCount,
            staleReservationsRejected,
          }),
        ),
        onlineRecoveryEqual: true,
      };
    },
    close() {
      for (const client of clients) {
        publisher.unsubscribe(client.id);
        client.assembler.clear();
      }
      return { subscribersRemaining: Number(publisher.hasSubscribers()) };
    },
  };
}
