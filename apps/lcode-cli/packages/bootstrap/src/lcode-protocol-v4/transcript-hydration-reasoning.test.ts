import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type MessageWithParts,
  type ModelStreamingPayload,
} from "@lcode/contracts";
import { synthesizeEventsFromMessages } from "./transcript-hydration.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

function transcript(parts: unknown[]): MessageWithParts[] {
  return [
    {
      info: {
        id: "user-one",
        role: "user",
        time: { created: 100 },
        modelSelection: { providerId: "fixture", modelId: "fixture" },
        anchor: { turnId: "turn-one" },
      },
      parts: [{ type: "text", id: "input", text: "hi" }],
    },
    {
      info: {
        id: "assistant-one",
        role: "assistant",
        parentID: "user-one",
        time: { created: 200, completed: 400 },
        anchor: { turnId: "turn-one" },
      },
      parts,
    },
  ] as unknown as MessageWithParts[];
}

function reasoningPayloads(messages: MessageWithParts[]) {
  return synthesizeEventsFromMessages(messages, { sessionId: "fixture", baseTimestampMs: 1_000 })
    .filter((event) => event.type === SessionEventType.ModelStreaming)
    .map((event) => event.payload as ModelStreamingPayload)
    .filter((payload) => payload.kind?.startsWith("reasoning_"));
}

test("twenty thousand word fragments produce three recovery events without losing text or signatures", () => {
  const texts = Array.from({ length: 20_000 }, (_, i) => ["A", " ", "中", "\n", "🙂", "."][i % 6]!);
  const parts = [
    { type: "reasoning", id: "empty-first", text: "" },
    ...texts.map((text, i) => ({
      type: "reasoning",
      id: `part-${i}`,
      text,
      metadata: { signature: `opaque-${i}` },
    })),
    { type: "text", id: "answer", text: "answer" },
  ];
  const messages = transcript(parts);
  const before = structuredClone(messages);
  const events = synthesizeEventsFromMessages(messages, { sessionId: "fixture" });
  const payloads = reasoningPayloads(messages);
  assert.equal(payloads.length, 3);
  assert.deepEqual(
    payloads.map((payload) => payload.kind),
    ["reasoning_start", "reasoning_delta", "reasoning_end"],
  );
  assert.equal(payloads[0]!.partId, "part-0");
  assert.equal(payloads[1]!.delta, texts.join(""));
  assert.ok(events.length < 20, "recovery event count must follow visible groups, not word count");
  assert.deepEqual(
    events.map((event) => event.sequenceNumber),
    events.map((_, i) => i + 1),
  );
  assert.deepEqual(messages, before);
});

test("text, tool, other part and assistant message boundaries preserve separate recovery groups", () => {
  const messages = transcript([
    { type: "reasoning", id: "r-one", text: "first" },
    { type: "reasoning", id: "r-space", text: " " },
    { type: "text", id: "body", text: "body" },
    { type: "reasoning", id: "r-two", text: "second" },
    { type: "reasoning", id: "r-empty", text: "" },
    {
      type: "tool",
      id: "tool-part",
      tool: "Read",
      callID: "read-one",
      state: {
        status: "completed",
        input: { path: "fixture.ts" },
        output: "fixture",
        time: { start: 220, end: 230 },
      },
    },
    { type: "reasoning", id: "r-three", text: "third" },
    { type: "step-start", id: "step-part" },
    { type: "reasoning", id: "r-four", text: "fourth" },
  ]);
  messages.push({
    info: {
      id: "assistant-two",
      role: "assistant",
      parentID: "user-one",
      time: { created: 300, completed: 400 },
      anchor: { turnId: "turn-one" },
    },
    parts: [{ type: "reasoning", id: "r-five", text: "fifth" }],
  } as unknown as MessageWithParts);
  const payloads = reasoningPayloads(messages);
  assert.deepEqual(
    payloads.filter((p) => p.kind === "reasoning_delta").map((p) => p.delta),
    ["first ", "second", "third", "fourth", "fifth"],
  );
  assert.deepEqual(
    payloads.filter((p) => p.kind === "reasoning_start").map((p) => p.assistantMessageId),
    ["assistant-one", "assistant-one", "assistant-one", "assistant-one", "assistant-two"],
  );
});

test("compaction keeps legacy row identities and source timestamps after discarded synthetic events", () => {
  const messages = transcript([
    ...["Alpha", " ", "beta.", ""].map((text, i) => ({ type: "reasoning", id: `r-${i}`, text })),
    { type: "text", id: "body", text: "answer" },
    ...["After", "\n"].map((text, i) => ({ type: "reasoning", id: `a-${i}`, text })),
    { type: "text", id: "tail", text: "done" },
  ]);
  const publisher = new ConversationTopicPublisher("fixture", "epoch");
  publisher.rehydrate(
    synthesizeEventsFromMessages(messages, { sessionId: "fixture", baseTimestampMs: 1_000 }),
  );
  assert.deepEqual(
    publisher.getSnapshot().rows.window.map((row) => [row.kind, row.rowId, row.createdAt]),
    [
      ["turnHeader", 1, 100],
      ["userInput", 2, 100],
      ["reasoning", 3, 1_004],
      ["assistantText", 4, 200],
      ["reasoning", 5, 1_016],
      ["assistantText", 6, 200],
    ],
  );
  assert.equal(publisher.isLatestEditableUserRow(2), true);
});

test("empty reasoning groups emit nothing and never mutate source parts", () => {
  const messages = transcript([
    { type: "reasoning", id: "empty", text: "" },
    { type: "text", id: "body", text: "answer" },
  ]);
  const before = structuredClone(messages);
  assert.deepEqual(reasoningPayloads(messages), []);
  assert.deepEqual(messages, before);
});

test("compacted and per-part histories preserve every row and target except recovery sequence", () => {
  const messages = transcript([
    ...Array.from({ length: 24 }, (_, i) => ({
      type: "reasoning",
      id: `r-${i}`,
      text: ["word", " ", "中", "\n", "🙂", "."][i % 6],
    })),
    { type: "text", id: "body", text: "answer" },
    {
      type: "tool",
      id: "tool",
      tool: "Read",
      callID: "read-one",
      state: {
        status: "completed",
        input: { path: "fixture.ts" },
        output: "fixture",
        time: { start: 250, end: 300 },
      },
    },
    { type: "reasoning", id: "tail-one", text: "after" },
    { type: "reasoning", id: "tail-two", text: " tool" },
    { type: "text", id: "tail", text: "done" },
  ]);
  messages.push({
    info: {
      id: "user-two",
      role: "user",
      time: {},
      modelSelection: { providerId: "fixture", modelId: "fixture" },
      anchor: { turnId: "turn-two" },
    },
    parts: [{ type: "text", id: "input-two", text: "next" }],
  } as unknown as MessageWithParts);
  // 空正文不产事件也不建行，但会打断合成分组，复现修复前逐 part 的恢复流。
  const unfolded = messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap<MessageWithParts["parts"][number]>((part) =>
      part.type === "reasoning" ? [part, { ...part, type: "text" as const, text: "" }] : [part],
    ),
  }));
  const publishers = [messages, unfolded].map((source) => {
    const publisher = new ConversationTopicPublisher("fixture", "epoch");
    publisher.rehydrate(
      synthesizeEventsFromMessages(source, { sessionId: "fixture", baseTimestampMs: 1_000 }),
    );
    return publisher;
  });
  const visibleRows = (publisher: ConversationTopicPublisher) =>
    publisher.getSnapshot().rows.window.map(({ createdAtSeq: _recoverySequence, ...row }) => row);
  assert.deepEqual(visibleRows(publishers[0]!), visibleRows(publishers[1]!));
  const targets = (publisher: ConversationTopicPublisher) =>
    publisher.getSnapshot().rows.window.map((row) => ({
      turnId: publisher.getTurnIdForRow(row.rowId),
      messages: publisher.getMessageIdsForTurnRow(row.rowId),
      fork: publisher.resolveStableForkCandidate(row.rowId),
      editable: publisher.isLatestEditableUserRow(row.rowId),
    }));
  assert.deepEqual(targets(publishers[0]!), targets(publishers[1]!));
  const snapshot = publishers[0]!.getSnapshot();
  assert.ok(
    snapshot.rows.window.every(
      (row, i, rows) =>
        row.createdAtSeq <= snapshot.seq &&
        (i === 0 || row.createdAtSeq >= rows[i - 1]!.createdAtSeq),
    ),
  );
});

for (const deliveryProfile of ["continuous", "replayable"] as const) {
  test(`${deliveryProfile} rehydrates a compacted history through the same subscription and recovery boundary`, () => {
    const publisher = new ConversationTopicPublisher("fixture", "epoch");
    const initial = publisher.subscribe({ connectionId: "connection-one", deliveryProfile });
    const messages = transcript([
      ...Array.from({ length: 1_000 }, (_, i) => ({
        type: "reasoning",
        id: `r-${i}`,
        text: "word ",
      })),
      { type: "text", id: "body", text: "answer" },
    ]);
    publisher.rehydrate(synthesizeEventsFromMessages(messages, { sessionId: "fixture" }));
    assert.equal(publisher.hasSubscription(initial.ack.subscriptionId, "connection-one"), true);
    const recovery = publisher.reserveFlush(initial.ack.subscriptionId);
    assert.equal(recovery?.frame.payload.kind, "snapshot");
    assert.equal(recovery?.commit(), true);
    const rows = publisher.getRowsRange({ limit: 60 }, deliveryProfile).rows;
    const reasoning = rows.filter((row) => row.kind === "reasoning");
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0]!.text, "word ".repeat(1_000));
    assert.equal(publisher.getSnapshot().control.phase, "completedSuccess");
  });
}
