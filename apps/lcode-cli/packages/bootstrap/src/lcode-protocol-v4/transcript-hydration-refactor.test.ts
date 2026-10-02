import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionEvent } from "@lcode/contracts";
import {
  goalVerificationEntriesFromSessionEntries,
  synthesizeEventsFromMessages,
} from "./transcript-hydration.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "./cold-event-merge.js";

function event(sequenceNumber: number, type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: `event-${sequenceNumber}` as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    turnId: "runtime-turn-1" as SessionEvent["turnId"],
    traceId: "trace-1" as SessionEvent["traceId"],
    timestamp: new Date(sequenceNumber),
    sequenceNumber,
    type,
    payload,
  };
}

function transcript(): MessageWithParts[] {
  return [
    {
      info: {
        id: "user-1",
        role: "user",
        time: { created: 100 },
        modelSelection: { providerId: "fixture", modelId: "model-1" },
        anchor: { turnId: "runtime-turn-1", sourceCommandId: "command-1" },
        metadata: { executionKind: "agent", epilogueStart: 5 },
      },
      parts: [
        { type: "text", id: "input-1", text: "hello\nengine note" },
        {
          type: "file",
          id: "file-1",
          filename: "image.png",
          mime: "image/png",
          url: "lcode-artifact://image",
          metadata: { sizeBytes: 7 },
        },
      ],
    },
    {
      info: {
        id: "assistant-1",
        role: "assistant",
        parentID: "user-1",
        time: { created: 120, completed: 180 },
        anchor: { turnId: "runtime-turn-1" },
        metadata: { assistantFeedback: "like" },
      },
      parts: [{ type: "text", id: "reply-1", text: "reply" }],
    },
  ] as unknown as MessageWithParts[];
}

test("hydration retains input identity, source timestamps, feedback and legacy goal events", () => {
  const messages = transcript();
  const original = structuredClone(messages);
  const goalVerificationEntries = goalVerificationEntriesFromSessionEntries([
    {
      time: { created: 181 },
      data: {
        sequenceNumber: 1,
        payload: {
          targetId: "goal-1",
          verificationId: "verify-1",
          goalIteration: 1,
          status: "started",
          anchorAssistantMessageId: "assistant-1",
        },
      },
    },
    {
      time: { created: 182 },
      data: {
        sequenceNumber: 2,
        payload: {
          targetId: "goal-1",
          verificationId: "verify-1",
          goalIteration: 1,
          status: "completed",
          verification: { passed: true, reason: "done", nextAction: null },
        },
      },
    },
  ]);
  const events = synthesizeEventsFromMessages(messages, {
    sessionId: "session-1",
    contextWindow: 1_000_000,
    goalVerificationEntries,
  });
  assert.equal(synthesizeEventsFromMessages.length, 2);
  assert.equal(goalVerificationEntriesFromSessionEntries.length, 1);
  assert.deepEqual(
    events.map((item) => item.sequenceNumber),
    events.map((_, index) => index + 1),
  );
  assert.ok(events.every((item) => item.traceId === "hydrate-trace"));
  const started = events.find((item) => item.type === SessionEventType.TurnStarted)!;
  assert.equal(started.timestamp.getTime(), 100);
  assert.deepEqual(started.payload, {
    turnNumber: 1,
    input: "hello\nengine note",
    epilogueStart: 5,
    messageId: "user-1",
    executionKind: "agent",
    inputId: "command-1",
    attachments: [
      { fileName: "image.png", mime: "image/png", bytes: 7, ref: "lcode-artifact://image" },
    ],
  });
  const textStarted = events.find(
    (item) =>
      item.type === SessionEventType.ModelStreaming &&
      (item.payload as { kind?: string }).kind === "text_start",
  )!;
  assert.equal(textStarted.timestamp.getTime(), 120);
  assert.deepEqual(
    events.find((item) => item.type === SessionEventType.AssistantFeedbackUpdated)?.payload,
    { entityId: "assistant-1", feedback: "like" },
  );
  const verifications = events.filter(
    (item) => item.type === SessionEventType.TargetCompletionVerification,
  );
  assert.equal(verifications.length, 2);
  assert.deepEqual(
    verifications.map((item) => (item.payload as { status: string }).status),
    ["started", "completed"],
  );
  assert.ok(verifications.every((item) => item.turnId === started.turnId));
  const modelComplete = events.find((item) => item.type === SessionEventType.ModelComplete);
  const turnComplete = events.at(-1);
  assert.ok(modelComplete);
  assert.ok(turnComplete);
  assert.equal((modelComplete.payload as { contextWindow: number }).contextWindow, 1_000_000);
  assert.equal((turnComplete.payload as { duration: number }).duration, 80);
  assert.deepEqual(messages, original);
});

test("cold merge keeps hook turn identity, pending queue lifecycle and unknown source payloads", () => {
  const memoryEvents = [
    event(1, SessionEventType.HookRunStarted, {
      hookInvocationId: "hook-1",
      hookEventName: "SessionStart",
    }),
    event(2, SessionEventType.TurnStarted, { input: "hello", messageId: "user-1" }),
    event(3, SessionEventType.TurnComplete, {}),
    event(4, SessionEventType.HookRunCompleted, {
      hookInvocationId: "hook-1",
      hookEventName: "SessionStart",
      opaque: { preserved: true },
    }),
    event(5, SessionEventType.TurnSteerQueued, {
      pendingInputId: "pending-1",
      text: "first",
      attachments: [{ ref: "artifact://retained" }],
    }),
    event(6, SessionEventType.TurnSteerQueued, { pendingInputId: "pending-1", text: "edited" }),
    event(7, SessionEventType.TurnSteerQueued, { pendingInputId: "settled-1" }),
    event(8, SessionEventType.TurnSteerDrained, { pendingInputIds: ["settled-1"] }),
    event(9, "future_source_event" as SessionEvent["type"], {
      opaque: { nested: [0, false, null] },
    }),
  ];
  const original = structuredClone(memoryEvents);
  const merged = mergeColdConversationEvents({
    sessionId: "session-1",
    messages: transcript(),
    memoryEvents,
  });
  const start = merged.events.find((item) => item.type === SessionEventType.TurnStarted)!;
  const hooks = merged.events.filter(
    (item) =>
      item.type === SessionEventType.HookRunStarted ||
      item.type === SessionEventType.HookRunCompleted,
  );
  assert.equal(hooks.length, 2);
  assert.ok(hooks.every((item) => item.turnId === start.turnId));
  assert.ok(merged.events.indexOf(hooks[1]!) < merged.events.indexOf(start));
  const queued = merged.events.filter((item) => item.type === SessionEventType.TurnSteerQueued);
  assert.deepEqual(
    queued.map((item) => item.payload),
    [memoryEvents[4]!.payload, memoryEvents[5]!.payload],
  );
  assert.deepEqual(merged.events.at(-1)?.payload, memoryEvents.at(-1)?.payload);
  assert.ok(
    merged.diagnostics.some((item) => item.code === "cold_merge.unclassified_event_preserved"),
  );
  assert.deepEqual(memoryEvents, original);
});

test("absent target authority differs from persisted null and materialization snapshots memory events", async () => {
  const targetChanged = event(1, SessionEventType.TargetChanged, {
    action: "set",
    target: { targetID: "goal-1" },
  });
  const memoryEvents = [targetChanged];
  const source = await loadPersistedConversationMaterialization({
    sessionId: "session-1",
    memoryEvents,
  });
  assert.equal(Object.hasOwn(source, "target"), false);
  memoryEvents.push(event(2, SessionEventType.SessionTitleUpdated, { title: "later" }));
  assert.equal(source.memoryEvents.length, 1);
  assert.equal(source.memoryEvents[0], targetChanged);
  const absent = mergeColdConversationEvents({
    sessionId: "session-1",
    messages: [],
    memoryEvents: source.memoryEvents,
  });
  assert.equal(absent.usedDurableTranscript, false);
  assert.ok(absent.events.some((item) => item.type === SessionEventType.TargetChanged));
  const cleared = mergeColdConversationEvents({
    sessionId: "session-1",
    messages: [],
    memoryEvents: source.memoryEvents,
    target: null,
  });
  assert.equal(cleared.usedDurableTranscript, true);
  assert.equal(
    cleared.events.some((item) => item.type === SessionEventType.TargetChanged),
    false,
  );
});
