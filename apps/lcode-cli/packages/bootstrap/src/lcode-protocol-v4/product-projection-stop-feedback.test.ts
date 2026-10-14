import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";

function fixture() {
  const projection = new ProductProjection("stop-fixture", "epoch-fixture");
  let seq = 0;
  const event = (
    type: SessionEvent["type"],
    payload: unknown,
    turnId = "turn-one",
  ): SessionEvent => ({
    id: `event-${++seq}` as SessionEvent["id"],
    sessionId: "stop-fixture" as SessionEvent["sessionId"],
    traceId: "trace-fixture" as SessionEvent["traceId"],
    turnId: turnId as SessionEvent["turnId"],
    timestamp: new Date(seq * 100),
    sequenceNumber: seq,
    type,
    payload,
  });
  const stream = (kind: string, delta = "", assistantMessageId = "assistant-one") =>
    event(SessionEventType.ModelStreaming, { kind, delta, done: false, assistantMessageId });
  const network = (type: string, extra = {}, turnId?: string) =>
    event(
      SessionEventType.ModelNetworkStatus,
      {
        type,
        requestId: "request-one",
        querySource: "main_turn",
        reason: "cancelled",
        retryable: false,
        ...extra,
      },
      turnId,
    );
  projection.applyEvent(
    event(SessionEventType.TurnStarted, { turnNumber: 1, messageId: "user-one", input: "fixture" }),
  );
  projection.applyEvent(network("model_request_started"));
  return { projection, event, stream, network };
}

function reasoning(snapshot: ConversationSnapshot) {
  return snapshot.rows.window.filter((row) => row.kind === "reasoning");
}

test("cancelled request ends thinking before delayed TurnComplete and preserves queued fragments", () => {
  const { projection, event, stream, network } = fixture();
  projection.applyEvent(stream("reasoning_delta", "Before"));
  let desktop = structuredClone(projection.getSnapshot());
  let mobile = structuredClone(desktop);
  const first = reasoning(desktop)[0]!;
  const apply = (e: SessionEvent) => {
    const deltas = projection.applyEvent(e);
    desktop = { ...applyConversationDeltas(desktop, deltas), seq: e.sequenceNumber };
    mobile = { ...applyConversationDeltas(mobile, deltas), seq: e.sequenceNumber };
    assert.deepEqual(desktop, projection.getSnapshot());
    assert.deepEqual(mobile, desktop);
  };
  apply(network("model_request_failed"));
  assert.equal(desktop.control.stopState, "stopping");
  assert.equal(desktop.control.phase, "running");
  assert.equal(reasoning(desktop)[0]!.state, "interrupted");
  assert.equal(desktop.rows.window.find((row) => row.kind === "turnHeader")?.state, "running");
  mobile = structuredClone(projection.getSnapshot());
  for (const fragment of [" ", "queued", "."]) {
    for (const e of [
      stream("reasoning_start"),
      stream("reasoning_delta", fragment),
      stream("reasoning_end"),
    ]) {
      apply(e);
      const rows = reasoning(desktop);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.state, "interrupted");
      assert.equal(rows[0]!.rowId, first.rowId);
    }
  }
  assert.equal(reasoning(desktop)[0]!.text, "Before queued.");
  apply(event(SessionEventType.TurnComplete, { resultType: "cancelled" }));
  assert.equal(desktop.control.stopState, "idle");
  assert.equal(desktop.control.phase, "completedInterrupted");
  assert.deepEqual(projection.applyEvent(stream("reasoning_delta", "late")), []);
});

test("cancelled request also closes text and queued text ends remain interrupted", () => {
  const { projection, stream, network } = fixture();
  projection.applyEvent(stream("text_delta", "partial"));
  projection.applyEvent(network("model_request_failed"));
  projection.applyEvent(stream("text_delta", " queued"));
  projection.applyEvent(stream("text_end"));
  const rows = projection.getSnapshot().rows.window.filter((row) => row.kind === "assistantText");
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => row.state === "interrupted"));
  assert.equal(rows.map((row) => row.text).join(""), "partial queued");
});

for (const querySource of ["project_memory_extract", "title_generation"]) {
  test(`ancillary ${querySource} cancellation does not stop thinking`, () => {
    const { projection, stream, network } = fixture();
    projection.applyEvent(stream("reasoning_delta", "thinking"));
    projection.applyEvent(network("model_request_failed", { querySource }));
    assert.equal(projection.getSnapshot().control.stopState, "stoppable");
    assert.equal(reasoning(projection.getSnapshot())[0]!.state, "streaming");
  });
}

for (const boundary of ["oldTurn", "oldRequest", "otherSession", "networkFailure"] as const) {
  test(`${boundary} cannot stop the current request`, () => {
    const { projection, stream, network } = fixture();
    projection.applyEvent(stream("reasoning_delta", "thinking"));
    const extra =
      boundary === "oldRequest"
        ? { requestId: "old-request" }
        : boundary === "networkFailure"
          ? { reason: "network_error", retryable: true }
          : {};
    const cancellation = network(
      "model_request_failed",
      extra,
      boundary === "oldTurn" ? "old-turn" : undefined,
    );
    if (boundary === "otherSession")
      cancellation.sessionId = "other-session" as SessionEvent["sessionId"];
    projection.applyEvent(cancellation);
    assert.equal(projection.getSnapshot().control.stopState, "stoppable");
    assert.equal(reasoning(projection.getSnapshot())[0]!.state, "streaming");
  });
}

test("model switch restores the same turn for a new request without reviving old reasoning", () => {
  const { projection, stream, network } = fixture();
  projection.applyEvent(stream("reasoning_delta", "old"));
  projection.applyEvent(network("model_request_failed"));
  projection.applyEvent(network("model_request_started", { requestId: "request-two" }));
  assert.equal(projection.getSnapshot().control.stopState, "stoppable");
  projection.applyEvent(stream("reasoning_delta", "new", "assistant-two"));
  projection.applyEvent(network("model_request_failed"));
  const rows = reasoning(projection.getSnapshot());
  assert.deepEqual(
    rows.map((row) => [row.text, row.state]),
    [
      ["old", "interrupted"],
      ["new", "streaming"],
    ],
  );
  assert.equal(projection.getSnapshot().control.stopState, "stoppable");
});

test("rejected cancellation candidate does not mutate streaming ownership", () => {
  const { projection, stream, network } = fixture();
  projection.applyEvent(stream("reasoning_delta", "before"));
  const cancelled = network("model_request_failed");
  const before = structuredClone(projection.getSnapshot());
  assert.equal(
    projection.applyEventAtomically(cancelled, () => false),
    null,
  );
  assert.deepEqual(projection.getSnapshot(), before);
  projection.applyEventAtomically(cancelled, () => true);
  assert.equal(reasoning(projection.getSnapshot())[0]!.state, "interrupted");
});

test("resumed text does not reuse the cancelled request's retained text index", () => {
  const { projection, stream, network } = fixture();
  projection.applyEvent(stream("text_delta", "old"));
  projection.applyEvent(network("model_request_failed"));
  projection.applyEvent(network("model_request_started", { requestId: "request-two" }));
  projection.applyEvent(stream("text_delta", "new", "assistant-two"));
  assert.deepEqual(
    projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText")
      .map((row) => [row.text, row.state]),
    [
      ["old", "interrupted"],
      ["new", "streaming"],
    ],
  );
});

test("a resumed delta-only request does not reuse a retained interrupted stream index", () => {
  const { projection, stream, network } = fixture();
  projection.applyEvent(stream("reasoning_delta", "old"));
  projection.applyEvent(network("model_request_failed"));
  projection.applyEvent(network("model_request_started", { requestId: "request-two" }));
  projection.applyEvent(stream("reasoning_delta", "new"));
  assert.deepEqual(
    reasoning(projection.getSnapshot()).map((row) => [row.text, row.state]),
    [
      ["old", "interrupted"],
      ["new", "streaming"],
    ],
  );
});
