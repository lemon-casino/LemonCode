import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  applyConversationDeltas,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  TopicWireFrameAssembler,
  type ConversationTopicFrame,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

function facts(sessionId = "session-one", querySource = "main_turn") {
  let sequenceNumber = 0;
  const event = (type: SessionEvent["type"], payload: unknown, turnId = "turn-one") =>
    ({
      id: `event-${++sequenceNumber}`,
      sessionId,
      traceId: "trace-one",
      turnId,
      timestamp: new Date(sequenceNumber * 100),
      sequenceNumber,
      type,
      payload,
    }) as SessionEvent;
  const start = () => event(SessionEventType.TurnStarted, { input: "测试", turnNumber: 1 });
  const network = (type: string, requestId: string, extra = {}, turnId = "turn-one") =>
    event(SessionEventType.ModelNetworkStatus, { type, requestId, querySource, ...extra }, turnId);
  const completed = (requestId = "request-one") =>
    network("model_request_completed", requestId, {
      durationMs: 2_000,
      usage: { inputTokens: 1_000, outputTokens: 100, reasoningTokens: 90 },
    });
  return { event, start, network, completed };
}

test("主会话和工作流子会话直接投影真实请求均速，ModelComplete 不丢新状态", () => {
  for (const querySource of ["main_turn", "subagent", "workflow_child"]) {
    const f = facts("session-one", querySource);
    const projection = new ProductProjection("session-one", "epoch-one");
    projection.applyEvent(f.start());
    projection.applyEvent(f.network("model_request_started", "request-one"));
    assert.equal(projection.getSnapshot().usage.modelOutput?.activeRequestId, "request-one");
    projection.applyEvent(f.completed());
    const output = projection.getSnapshot().usage.modelOutput;
    assert.equal(output?.activeRequestId, null);
    assert.equal(output?.lastRequest?.outputTokens, 100);
    assert.equal(output?.lastRequest?.durationMs, 2_000);
    assert.equal(projection.getSnapshot().usage.cumulative.outputTokens, 0);
    projection.applyEvent(f.completed());
    assert.deepEqual(projection.getSnapshot().usage.modelOutput, output);
    projection.applyEvent(
      f.event(SessionEventType.ModelComplete, {
        querySource,
        content: "",
        stopReason: "tool-calls",
        usage: { outputTokens: 100 },
      }),
    );
    assert.deepEqual(projection.getSnapshot().usage.modelOutput, output);
    assert.equal(projection.getSnapshot().usage.cumulative.outputTokens, 100);
    projection.applyEvent(f.event(SessionEventType.TurnComplete, { resultType: "success" }));
    assert.deepEqual(projection.getSnapshot().usage.modelOutput, output);
    conversationSnapshotSchema.parse(projection.getSnapshot());
  }
});

test("旧请求、外部会话与维护请求不能污染当前统计，停止和新轮次清理", () => {
  const f = facts();
  const projection = new ProductProjection("session-one", "epoch-one");
  projection.applyEvent(f.start());
  projection.applyEvent(f.network("model_request_started", "request-one"));
  projection.applyEvent(f.network("model_request_started", "request-two"));
  projection.applyEvent(f.completed("request-one"));
  assert.equal(projection.getSnapshot().usage.modelOutput?.activeRequestId, "request-two");
  projection.applyEvent(
    f.network("model_request_completed", "request-two", {
      durationMs: 2_000,
      usage: { outputTokens: 100 },
      querySource: "session_title",
    }),
  );
  projection.applyEvent({
    ...f.completed("request-two"),
    sessionId: "other-session",
  } as SessionEvent);
  assert.equal(projection.getSnapshot().usage.modelOutput?.lastRequest, null);
  projection.applyEvent(f.network("model_request_failed", "request-two", { retryable: true }));
  assert.equal(projection.getSnapshot().usage.modelOutput?.activeRequestId, null);
  projection.applyEvent(f.network("model_request_started", "request-three"));
  projection.applyEvent(f.event(SessionEventType.TurnComplete, { resultType: "cancelled" }));
  assert.equal(projection.getSnapshot().usage.modelOutput?.activeRequestId, null);
  projection.applyEvent(f.completed("request-three"));
  assert.equal(projection.getSnapshot().usage.modelOutput?.lastRequest, null);
  projection.applyEvent(
    f.event(SessionEventType.TurnStarted, { input: "第二轮", turnNumber: 2 }, "turn-two"),
  );
  assert.equal(projection.getSnapshot().usage.modelOutput, null);
  projection.applyEvent(f.network("model_request_started", "request-four", {}, "turn-two"));
  projection.applyEvent(f.completed("request-three"));
  assert.equal(projection.getSnapshot().usage.modelOutput?.activeRequestId, "request-four");
});

test("未知或无效用量/耗时不伪装成准确均速，旧快照继续可读", () => {
  for (const extra of [
    { durationMs: 0, usage: { outputTokens: 100 } },
    { durationMs: Number.NaN, usage: { outputTokens: 100 } },
    { durationMs: 2_000, usage: {} },
    { durationMs: 2_000, usage: { outputTokens: 0 } },
    { durationMs: 2_000, usage: { outputTokens: -1 } },
  ]) {
    const f = facts();
    const projection = new ProductProjection("session-one", "epoch-one");
    projection.applyEvent(f.start());
    projection.applyEvent(f.network("model_request_started", "request-one"));
    projection.applyEvent(f.network("model_request_completed", "request-one", extra));
    assert.equal(projection.getSnapshot().usage.modelOutput?.lastRequest, null);
    conversationSnapshotSchema.parse(projection.getSnapshot());
  }
  conversationSnapshotSchema.parse(new ProductProjection("old-session", "epoch-old").getSnapshot());
});

function transmit(reservation: TopicFrameReservation<ConversationTopicFrame>, fragmented: boolean) {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const frames = encodeTopicWireFrames(reservation.frame, {
    ...reservation,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    ...(fragmented ? { maxPhysicalFrameBytes: 2_048 } : {}),
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }).flatMap((wire) => assembler.accept(wire, 100));
  assert.equal(frames.length, 1);
  assert.equal(reservation.commit(), true);
  const complete = frames[0];
  assert.ok(complete?.kind === "complete");
  return complete.frame;
}

for (const profile of ["continuous", "replayable"] as const) {
  for (const fragmented of [false, true]) {
    test(`${profile} ${fragmented ? "分片" : "完整帧"}在线与恢复均携带同一请求统计`, () => {
      const f = facts("session-one", "workflow_child");
      const publisher = new ConversationTopicPublisher("session-one", "epoch-one");
      const subscribed = publisher.subscribeReserved({
        connectionId: "connection-one",
        deliveryProfile: profile,
      });
      assert.ok(subscribed.reservation);
      const initial = transmit(subscribed.reservation, fragmented);
      assert.ok(initial.payload.kind === "snapshot");
      publisher.ingest(f.start());
      publisher.ingest(f.network("model_request_started", "request-one"));
      publisher.ingest(f.completed());
      const online = publisher.reserveFlush(subscribed.ack.subscriptionId);
      assert.ok(online);
      const deltaFrame = transmit(online, fragmented);
      assert.ok(deltaFrame.payload.kind === "deltas");
      const client = applyConversationDeltas(initial.payload.snapshot, deltaFrame.payload.deltas);
      assert.equal(client.usage.modelOutput?.lastRequest?.outputTokens, 100);
      conversationSnapshotSchema.parse(client);
      const resync = publisher.resyncReserved(subscribed.ack.subscriptionId, {
        base: null,
        forceSnapshot: true,
      });
      assert.ok(resync?.reservation);
      const recovered = transmit(resync.reservation, fragmented);
      assert.ok(recovered.payload.kind === "snapshot");
      assert.deepEqual(recovered.payload.snapshot.usage.modelOutput, client.usage.modelOutput);
    });
  }
}
