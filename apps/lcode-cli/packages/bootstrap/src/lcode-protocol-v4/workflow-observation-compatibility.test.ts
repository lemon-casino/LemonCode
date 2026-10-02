import assert from "node:assert/strict";
import test from "node:test";
import {
  listWorkflowRunsToolResultDisplayPayloadSchema,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
} from "@lcode/contracts";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  toolCallListWorkflowRunsDisplaySchema,
  TopicWireFrameAssembler,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { synthesizeEventsFromMessages } from "./transcript-hydration.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

const run = {
  runId: "run-current",
  label: "修订后的工作流",
  labelSource: "name" as const,
  status: "stopped" as const,
  stopReason: "superseded" as const,
  ownedByThisSession: false,
  createdAt: 1,
  updatedAt: 2,
  spentTokens: 100,
};
const display = listWorkflowRunsToolResultDisplayPayloadSchema.parse({
  kind: "list_workflow_runs",
  runs: [{ ...run, resumedFrom: "run-before", supersededBy: "run-after" }],
});

test("ListWorkflowRuns CLI 与 V4 消费契约逐字段一致（含修订关系）", () => {
  assert.deepEqual(
    Object.keys(toolCallListWorkflowRunsDisplaySchema.shape.runs.element.shape).sort(),
    Object.keys(listWorkflowRunsToolResultDisplayPayloadSchema.shape.runs.element.shape).sort(),
  );
  for (const lineage of [
    {},
    { resumedFrom: "run-before" },
    { supersededBy: "run-after" },
    { resumedFrom: "run-before", supersededBy: "run-after" },
  ]) {
    const payload = { kind: "list_workflow_runs", runs: [{ ...run, ...lineage }] };
    assert.deepEqual(toolCallListWorkflowRunsDisplaySchema.parse(payload), payload);
  }
});

test("修订字段仍严格校验，旧卡片可读、未知字段不可吞掉", () => {
  for (const invalid of [
    { resumedFrom: "" },
    { supersededBy: "" },
    { resumedFrom: null },
    { supersededBy: 1 },
    { unknownLineage: "run-other" },
  ]) {
    const payload = { kind: "list_workflow_runs", runs: [{ ...run, ...invalid }] };
    assert.equal(listWorkflowRunsToolResultDisplayPayloadSchema.safeParse(payload).success, false);
    assert.equal(toolCallListWorkflowRunsDisplaySchema.safeParse(payload).success, false);
  }
});

function event(sequenceNumber: number, type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: `event-${sequenceNumber}` as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    turnId: "turn-1" as SessionEvent["turnId"],
    traceId: "trace-1" as SessionEvent["traceId"],
    timestamp: new Date(sequenceNumber),
    sequenceNumber,
    type,
    payload,
  };
}

const liveEvents = [
  event(1, SessionEventType.TurnStarted, {
    turnNumber: 1,
    input: "查看工作流",
    messageId: "msg-user",
  }),
  event(2, SessionEventType.ToolCallScheduled, {
    toolCallId: "call-list",
    toolName: "ListWorkflowRuns",
    input: {},
    schedule: { executionOrder: ["call-list"], parallelGroups: [["call-list"]] },
  }),
  event(3, SessionEventType.ToolCallStarted, {
    toolCallId: "call-list",
    toolName: "ListWorkflowRuns",
    startedAt: new Date(3),
  }),
  event(4, SessionEventType.ToolCallResult, {
    toolCallId: "call-list",
    duration: 1,
    result: { success: true, content: "工作流列表", display },
  }),
  event(5, SessionEventType.TurnComplete, {
    response: "已完成",
    tokenCount: 0,
    toolCallCount: 1,
    duration: 5,
    resultType: "success",
  }),
];

function assertDisplay(snapshot: ConversationSnapshot): void {
  conversationSnapshotSchema.parse(snapshot);
  const row = snapshot.rows.window.find((item) => item.kind === "toolCall");
  assert.ok(row?.kind === "toolCall");
  assert.deepEqual(row.display, display);
  assert.deepEqual(row.output?.display, display);
}

function transmit(reservation: TopicFrameReservation<ConversationTopicFrame>, fragmented: boolean) {
  const wires = encodeTopicWireFrames(reservation.frame, {
    ...reservation,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    ...(fragmented ? { maxPhysicalFrameBytes: 2_048 } : {}),
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  });
  assert.equal(wires[0]?.kind, fragmented ? "fragment" : "complete");
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const assembled = wires.flatMap((wire) => assembler.accept(wire, 100));
  assert.equal(assembled.length, 1);
  const complete = assembled[0];
  assert.ok(complete?.kind === "complete");
  assert.equal(complete.deliveryKind, reservation.deliveryKind);
  assert.equal(reservation.commit(), true);
  return complete.frame;
}

for (const profile of ["continuous", "replayable"] as const) {
  for (const fragmented of [false, true]) {
    test(`${profile} ${fragmented ? "分片" : "完整帧"}：live、重开、同订阅恢复保留工作流修订关系`, () => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const initial = publisher.subscribeReserved({
        connectionId: "connection-1",
        deliveryProfile: profile,
      });
      assert.ok(initial.reservation);
      const initialFrame = transmit(initial.reservation, fragmented);
      assert.equal(initialFrame.payload.kind, "snapshot");
      assert.ok(initialFrame.payload.kind === "snapshot");
      let client = initialFrame.payload.snapshot;
      for (const fact of liveEvents) publisher.ingest(fact);
      const online = publisher.reserveFlush(initial.ack.subscriptionId);
      assert.ok(online);
      assert.equal(online.deliveryKind, "online");
      const onlineFrame = transmit(online, fragmented);
      assert.ok(onlineFrame.payload.kind === "deltas");
      client = applyConversationDeltas(client, onlineFrame.payload.deltas);
      assertDisplay(client);

      const resumed = publisher.resyncReserved(initial.ack.subscriptionId, {
        base: { logEpoch: client.logEpoch, seq: initialFrame.toSeq },
      });
      assert.equal(resumed?.ack.mode, "resume");
      assert.ok(resumed?.reservation);
      assert.equal(resumed.reservation.deliveryKind, "recovery");
      const replay = transmit(resumed.reservation, fragmented);
      assert.ok(replay.payload.kind === "deltas");
      assertDisplay(applyConversationDeltas(initialFrame.payload.snapshot, replay.payload.deltas));

      const forced = publisher.resyncReserved(initial.ack.subscriptionId, {
        base: null,
        forceSnapshot: true,
      });
      assert.ok(forced?.reservation);
      assert.equal(forced.reservation.deliveryKind, "recovery");
      const recovered = transmit(forced.reservation, fragmented);
      assert.ok(recovered.payload.kind === "snapshot");
      assertDisplay(recovered.payload.snapshot);

      const reopened = publisher.subscribeReserved({
        connectionId: "connection-1",
        deliveryProfile: profile,
      });
      assert.ok(reopened.reservation);
      const reopenedFrame = transmit(reopened.reservation, fragmented);
      assert.ok(reopenedFrame.payload.kind === "snapshot");
      assertDisplay(reopenedFrame.payload.snapshot);
    });
  }
}

test("历史工具 metadata 经 transcript 冷恢复后快照合法，行和输出的修订关系不丢失", () => {
  const messages = [
    {
      info: { id: "msg-user", role: "user", time: { created: 1 } },
      parts: [{ id: "part-user", type: "text", text: "查看工作流" }],
    },
    {
      info: { id: "msg-assistant", role: "assistant", time: { created: 2, completed: 5 } },
      parts: [
        {
          id: "part-list",
          type: "tool",
          tool: "ListWorkflowRuns",
          callID: "call-list",
          state: {
            status: "completed",
            input: {},
            output: "工作流列表",
            time: { start: 3, end: 4 },
            metadata: { schemaVersion: 1, display },
          },
        },
      ],
    },
  ] as MessageWithParts[];
  const publisher = new ConversationTopicPublisher("session-1", "epoch-cold");
  publisher.rehydrate(synthesizeEventsFromMessages(messages, { sessionId: "session-1" }));
  assertDisplay(publisher.getSnapshot());
});
