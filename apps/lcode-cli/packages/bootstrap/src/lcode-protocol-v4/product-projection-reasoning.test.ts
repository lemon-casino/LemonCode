import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type MessageWithParts,
  type ModelStreamingPayload,
  type SessionEvent,
} from "@lcode/contracts";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
  type ReasoningRow,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { synthesizeEventsFromMessages } from "./transcript-hydration.js";

const SESSION_ID = "reasoning-fixture";
const RESPONSE_ID = "assistant-fixture";
const TURN_ID = "turn-fixture";
const FRAGMENTS = ["", "A", " ", "short", " ", "thought", ".", "\n", "", "Next", "."];

function fixture() {
  const projection = new ProductProjection(SESSION_ID, "epoch-fixture");
  let sequenceNumber = 0;
  const event = (type: SessionEvent["type"], payload: unknown, turnId = TURN_ID): SessionEvent => ({
    id: `event-${++sequenceNumber}` as SessionEvent["id"],
    sessionId: SESSION_ID as SessionEvent["sessionId"],
    traceId: "trace-fixture" as SessionEvent["traceId"],
    turnId: turnId as SessionEvent["turnId"],
    timestamp: new Date(sequenceNumber * 100),
    sequenceNumber,
    type,
    payload,
  });
  const stream = (
    kind: ModelStreamingPayload["kind"],
    delta = "",
    extra: Record<string, unknown> = {},
  ) =>
    event(SessionEventType.ModelStreaming, {
      kind,
      delta,
      done: false,
      assistantMessageId: RESPONSE_ID,
      ...extra,
    });
  projection.applyEvent(
    event(SessionEventType.TurnStarted, {
      turnNumber: 1,
      messageId: "user-fixture",
      input: "fixture input",
    }),
  );
  const block = (text: string, extra: Record<string, unknown> = {}) => {
    projection.applyEvent(stream("reasoning_start", "", extra));
    projection.applyEvent(stream("reasoning_delta", text, extra));
    projection.applyEvent(stream("reasoning_end", "", extra));
  };
  return { projection, event, stream, block };
}

function reasoning(snapshot: ConversationSnapshot): ReasoningRow[] {
  return snapshot.rows.window.filter((row): row is ReasoningRow => row.kind === "reasoning");
}

test("word and empty blocks retain one row through continuous delivery and replayable resume", () => {
  const { projection, stream } = fixture();
  let desktop = structuredClone(projection.getSnapshot());
  let mobile = structuredClone(desktop);
  let firstRow: ReasoningRow | undefined;
  let text = "";
  for (const [index, fragment] of FRAGMENTS.entries()) {
    const extra = { partId: `part-${index}` };
    for (const event of [
      stream("reasoning_start", "", extra),
      stream("reasoning_delta", fragment, extra),
      stream("reasoning_end", "", extra),
    ]) {
      const deltas = projection.applyEvent(event);
      desktop = { ...applyConversationDeltas(desktop, deltas), seq: event.sequenceNumber };
      mobile = { ...applyConversationDeltas(mobile, deltas), seq: event.sequenceNumber };
      assert.deepEqual(desktop, projection.getSnapshot());
      assert.deepEqual(mobile, desktop);
      const rows = reasoning(desktop);
      assert.equal(rows.length, 1);
      firstRow ??= rows[0]!;
      assert.equal(rows[0]!.rowId, firstRow.rowId);
      assert.equal(rows[0]!.entityId, firstRow.entityId);
      assert.equal(rows[0]!.createdAt, firstRow.createdAt);
    }
    text += fragment;
    assert.equal(reasoning(desktop)[0]!.text, text);
    assert.equal(reasoning(desktop)[0]!.state, "complete");
    // 手机允许在任意 block 边界恢复快照；下一块仍复用同一行。
    mobile = structuredClone(projection.getSnapshot());
  }
});

test("duplicate start and delta without start reuse the current response", () => {
  const { projection, stream, block } = fixture();
  projection.applyEvent(stream("reasoning_delta", "one"));
  projection.applyEvent(stream("reasoning_start"));
  projection.applyEvent(stream("reasoning_start"));
  projection.applyEvent(stream("reasoning_delta", " two"));
  projection.applyEvent(stream("reasoning_end"));
  projection.applyEvent(stream("reasoning_delta", " three"));
  block(" four");
  assert.equal(reasoning(projection.getSnapshot()).length, 1);
  assert.equal(reasoning(projection.getSnapshot())[0]!.text, "one two three four");
});

for (const boundary of ["text", "tool", "response", "turn", "missingIdentity"] as const) {
  test(`reasoning does not merge across ${boundary}`, () => {
    const { projection, stream, event, block } = fixture();
    block("first");
    let extra: Record<string, unknown> = {};
    if (boundary === "text") {
      projection.applyEvent(stream("text_delta", "body"));
      projection.applyEvent(stream("text_end"));
    } else if (boundary === "tool") {
      projection.applyEvent(
        stream("tool_input_start", "", {
          toolCallId: "tool-fixture",
          toolName: "Read",
        }),
      );
    } else if (boundary === "response") {
      extra = { assistantMessageId: "assistant-second" };
    } else if (boundary === "turn") {
      projection.applyEvent(event(SessionEventType.TurnComplete, { resultType: "success" }));
      projection.applyEvent(
        event(
          SessionEventType.TurnStarted,
          {
            turnNumber: 2,
            messageId: "user-second",
            input: "next input",
          },
          "turn-second",
        ),
      );
    } else {
      extra = { assistantMessageId: undefined };
    }
    block("second", extra);
    assert.deepEqual(
      reasoning(projection.getSnapshot()).map((row) => row.text),
      ["first", "second"],
    );
  });
}

test("delta-only response changes and interleaved text preserve row order", () => {
  const { projection, stream } = fixture();
  projection.applyEvent(stream("reasoning_delta", "first"));
  projection.applyEvent(
    stream("reasoning_delta", "second", { assistantMessageId: "assistant-second" }),
  );
  projection.applyEvent(stream("text_delta", "body", { assistantMessageId: "assistant-second" }));
  projection.applyEvent(
    stream("reasoning_delta", "third", { assistantMessageId: "assistant-second" }),
  );
  const rows = projection
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "reasoning" || row.kind === "assistantText");
  assert.deepEqual(
    rows.map((row) => row.text),
    ["first", "second", "body", "third"],
  );
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["reasoning", "reasoning", "assistantText", "reasoning"],
  );
});

test("interrupted reasoning cannot reopen and terminal late events cannot revive it", () => {
  const { projection, stream, event } = fixture();
  projection.applyEvent(stream("reasoning_delta", "first"));
  projection.applyEvent(event(SessionEventType.TurnComplete, { resultType: "cancelled" }));
  const before = reasoning(projection.getSnapshot());
  assert.equal(before[0]!.state, "interrupted");
  assert.deepEqual(projection.applyEvent(stream("reasoning_delta", "late")), []);
  assert.deepEqual(reasoning(projection.getSnapshot()), before);
});

test("atomic rejection before reopening leaves text and streaming indices intact", () => {
  const { projection, stream, block } = fixture();
  block("first");
  const next = stream("reasoning_delta", " second");
  const before = structuredClone(projection.getSnapshot());
  assert.equal(
    projection.applyEventAtomically(next, () => false),
    null,
  );
  assert.deepEqual(projection.getSnapshot(), before);
  const deltas = projection.applyEventAtomically(next, () => true)!;
  const delivered = { ...applyConversationDeltas(before, deltas), seq: next.sequenceNumber };
  assert.deepEqual(delivered, projection.getSnapshot());
  assert.equal(reasoning(delivered).length, 1);
  assert.equal(reasoning(delivered)[0]!.text, "first second");
});

test("publisher append estimate requires an existing matching tail row", () => {
  const { projection, stream } = fixture();
  const initial = stream("reasoning_delta", "first");
  assert.equal(projection.establishedStreamingAppend(initial), null);
  projection.applyEvent(initial);
  assert.equal(projection.establishedStreamingAppend(stream("reasoning_delta", " next")), " next");
  assert.equal(
    projection.establishedStreamingAppend(
      stream("reasoning_delta", "other", {
        assistantMessageId: "assistant-other",
      }),
    ),
    null,
  );
  projection.applyEvent(stream("text_delta", "body"));
  assert.equal(
    projection.establishedStreamingAppend(stream("reasoning_delta", "after body")),
    null,
  );
});

test("cold hydration consolidates persisted fragments without mutating original parts", () => {
  const messages = [
    {
      info: {
        id: "user-fixture",
        role: "user",
        time: { created: 100 },
        modelSelection: { providerId: "fixture", modelId: "fixture" },
        anchor: { turnId: TURN_ID },
      },
      parts: [{ type: "text", id: "input-fixture", text: "fixture input" }],
    },
    {
      info: {
        id: RESPONSE_ID,
        role: "assistant",
        parentID: "user-fixture",
        time: { created: 200, completed: 300 },
        anchor: { turnId: TURN_ID },
      },
      parts: [
        ...FRAGMENTS.map((text, index) => ({
          type: "reasoning",
          id: `part-${index}`,
          text,
          metadata: { providerOptions: { anthropic: { signature: `opaque-${index}` } } },
        })),
        { type: "text", id: "reply-fixture", text: "answer" },
      ],
    },
  ] as unknown as MessageWithParts[];
  const original = structuredClone(messages);
  const projection = new ProductProjection(SESSION_ID, "epoch-fixture");
  projection.beginHydrationReplay();
  for (const event of synthesizeEventsFromMessages(messages, { sessionId: SESSION_ID })) {
    projection.applyHydrationEvent(event);
  }
  projection.completeHydrationReplay();
  const { projection: live, block, stream } = fixture();
  for (const fragment of FRAGMENTS) block(fragment);
  live.applyEvent(stream("text_delta", "answer"));
  live.applyEvent(stream("text_end"));
  assert.equal(reasoning(projection.getSnapshot()).length, 1);
  const pick = (snapshot: ConversationSnapshot) =>
    reasoning(snapshot).map(({ text, state, assistantResponseId }) => ({
      text,
      state,
      assistantResponseId,
    }));
  assert.deepEqual(pick(projection.getSnapshot()), pick(live.getSnapshot()));
  assert.deepEqual(messages, original);
});
