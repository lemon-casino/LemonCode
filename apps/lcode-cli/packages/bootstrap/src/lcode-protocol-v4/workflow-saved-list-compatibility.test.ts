import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  savedWorkflowListToolResultDisplayPayloadSchema,
  SessionEventType,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS,
  type MessageWithParts,
  type SavedWorkflowListToolResultDisplayPayload,
  type SessionEvent,
} from "@lcode/contracts";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  toolCallSavedWorkflowListDisplaySchema,
  TopicWireFrameAssembler,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { synthesizeEventsFromMessages } from "./transcript-hydration.js";

const fragmentedFrameBytes = 2_048;
const row = {
  name: "review",
  description: "检查代码",
  whenToUse: "提交之前",
  scope: "project",
  path: "project/review.dwf.ts",
  argNames: ["target", "depth"],
};
const invalid = [{ path: "project/broken.dwf.ts", reason: "无法读取定义" }];
const displays = {
  empty: { kind: "saved_workflow_list", workflows: [] },
  "invalid-only": { kind: "saved_workflow_list", workflows: [], invalid },
  mixed: {
    kind: "saved_workflow_list",
    workflows: [row, { ...row, scope: "global", path: "global/review.dwf.ts" }],
    invalid,
  },
  "bounded-truncated": {
    kind: "saved_workflow_list",
    workflows: Array.from({ length: WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS }, (_, index) => ({
      ...row,
      name: `review-${WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS - index}`,
      path: `project/review-${index}.dwf.ts`,
      ...(index === 0
        ? {
            description: "𐐀".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS / 4),
            whenToUse: "界".repeat(Math.floor(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS / 3)),
            argNames: Array.from(
              { length: WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS },
              (_, arg) => `arg-${WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS - arg}`,
            ),
          }
        : {}),
    })),
    invalid: [
      { ...invalid[0], reason: "𐐀".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS / 4) },
    ],
    truncated: true,
  },
} satisfies Record<string, SavedWorkflowListToolResultDisplayPayload>;

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

function liveEvents(display: SavedWorkflowListToolResultDisplayPayload) {
  return [
    event(1, SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "查看工作流模板",
      messageId: "msg-user",
    }),
    event(2, SessionEventType.ToolCallScheduled, {
      toolCallId: "call-list",
      toolName: LIST_SAVED_WORKFLOWS_TOOL_NAME,
      input: {},
      schedule: { executionOrder: ["call-list"], parallelGroups: [["call-list"]] },
    }),
    event(3, SessionEventType.ToolCallStarted, {
      toolCallId: "call-list",
      toolName: LIST_SAVED_WORKFLOWS_TOOL_NAME,
      startedAt: new Date(3),
    }),
    event(4, SessionEventType.ToolCallResult, {
      toolCallId: "call-list",
      duration: 1,
      result: { success: true, content: "工作流模板列表", display },
    }),
    event(5, SessionEventType.TurnComplete, {
      response: "已完成",
      tokenCount: 0,
      toolCallCount: 1,
      duration: 5,
      resultType: "success",
    }),
  ];
}

function assertDisplay(
  snapshot: ConversationSnapshot,
  display: SavedWorkflowListToolResultDisplayPayload,
): void {
  conversationSnapshotSchema.parse(snapshot);
  const tool = snapshot.rows.window.find((item) => item.kind === "toolCall");
  assert.ok(tool?.kind === "toolCall");
  assert.deepEqual(tool.output?.display, display);
  assert.deepEqual(tool.display, display);
  assert.deepEqual(toolCallSavedWorkflowListDisplaySchema.parse(tool.output?.display), display);
  assert.deepEqual(savedWorkflowListToolResultDisplayPayloadSchema.parse(tool.display), display);
}

function transmit(reservation: TopicFrameReservation<ConversationTopicFrame>, fragmented: boolean) {
  const wires = encodeTopicWireFrames(reservation.frame, {
    ...reservation,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    ...(fragmented ? { maxPhysicalFrameBytes: fragmentedFrameBytes } : {}),
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  });
  assert.equal(wires[0]?.kind, fragmented ? "fragment" : "complete");
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const assembled = wires.flatMap((wire) =>
    assembler.accept(JSON.parse(JSON.stringify(wire)), 100),
  );
  assert.equal(assembled.length, 1);
  const complete = assembled[0];
  assert.ok(complete?.kind === "complete");
  assert.equal(complete.deliveryKind, reservation.deliveryKind);
  assert.equal(reservation.commit(), true);
  return complete.frame;
}

for (const [scenario, display] of Object.entries(displays)) {
  for (const profile of ["continuous", "replayable"] as const) {
    for (const fragmented of [false, true]) {
      const label = `${scenario} ${profile} ${fragmented ? "fragmented" : "complete"}`;
      test(`saved list ${label}: online, snapshot, and recovery retain both display locations`, () => {
        const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
        const initial = publisher.subscribeReserved({
          connectionId: "connection-1",
          deliveryProfile: profile,
        });
        assert.ok(initial.reservation);
        const initialFrame = transmit(initial.reservation, fragmented);
        assert.ok(initialFrame.payload.kind === "snapshot");
        for (const fact of liveEvents(display)) publisher.ingest(fact);

        const online = publisher.reserveFlush(initial.ack.subscriptionId);
        assert.ok(online);
        assert.equal(online.deliveryKind, "online");
        const onlineFrame = transmit(online, fragmented);
        assert.ok(onlineFrame.payload.kind === "deltas");
        const client = applyConversationDeltas(
          initialFrame.payload.snapshot,
          onlineFrame.payload.deltas,
        );
        assertDisplay(client, display);

        const resumed = publisher.resyncReserved(initial.ack.subscriptionId, {
          base: { logEpoch: client.logEpoch, seq: initialFrame.toSeq },
        });
        assert.equal(resumed?.ack.mode, "resume");
        assert.ok(resumed?.reservation);
        assert.equal(resumed.reservation.deliveryKind, "recovery");
        const replay = transmit(resumed.reservation, fragmented);
        assert.ok(replay.payload.kind === "deltas");
        assertDisplay(
          applyConversationDeltas(initialFrame.payload.snapshot, replay.payload.deltas),
          display,
        );

        const forced = publisher.resyncReserved(initial.ack.subscriptionId, {
          base: null,
          forceSnapshot: true,
        });
        assert.ok(forced?.reservation);
        assert.equal(forced.reservation.deliveryKind, "recovery");
        const recovered = transmit(forced.reservation, fragmented);
        assert.ok(recovered.payload.kind === "snapshot");
        assertDisplay(recovered.payload.snapshot, display);

        const reopened = publisher.subscribeReserved({
          connectionId: "connection-1",
          deliveryProfile: profile,
        });
        assert.ok(reopened.reservation);
        const reopenedFrame = transmit(reopened.reservation, fragmented);
        assert.ok(reopenedFrame.payload.kind === "snapshot");
        assertDisplay(reopenedFrame.payload.snapshot, display);
      });

      test(`saved list ${label}: cold metadata hydration preserves history and both display locations`, () => {
        const messages = [
          {
            info: { id: "msg-user", role: "user", time: { created: 1 } },
            parts: [{ id: "part-user", type: "text", text: "查看工作流模板" }],
          },
          {
            info: { id: "msg-assistant", role: "assistant", time: { created: 2, completed: 5 } },
            parts: [
              {
                id: "part-list",
                type: "tool",
                tool: LIST_SAVED_WORKFLOWS_TOOL_NAME,
                callID: "call-list",
                state: {
                  status: "completed",
                  input: {},
                  output: "工作流模板列表",
                  time: { start: 3, end: 4 },
                  metadata: { schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, display },
                },
              },
            ],
          },
        ] as MessageWithParts[];
        const persisted = JSON.stringify(messages);
        const history = JSON.parse(persisted) as MessageWithParts[];
        const publisher = new ConversationTopicPublisher("session-1", "epoch-cold");
        publisher.rehydrate(synthesizeEventsFromMessages(history, { sessionId: "session-1" }));
        assert.equal(JSON.stringify(history), persisted);
        assertDisplay(publisher.getSnapshot(), display);
        const cold = publisher.subscribeReserved({
          connectionId: "connection-cold",
          deliveryProfile: profile,
        });
        assert.ok(cold.reservation);
        const coldFrame = transmit(cold.reservation, fragmented);
        assert.ok(coldFrame.payload.kind === "snapshot");
        assertDisplay(coldFrame.payload.snapshot, display);
      });
    }
  }
}
