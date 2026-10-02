import assert from "node:assert/strict";
import test from "node:test";
import { apply, EventReducer, reduce } from "./event-reducer.js";
import { createSessionEvent, SessionEventType as E } from "./session.events.js";
import type { SessionEvent } from "./session.events.js";
import type { TurnInputIntentMetadata } from "../interfaces/session.port.js";
import { createSessionId, createTurnId } from "../interfaces/shared.js";

const sessionId = createSessionId("reducer-contract");
const turnId = createTurnId("reducer-contract");

function event(type: SessionEvent["type"], payload: unknown, time = 1): SessionEvent {
  return {
    ...createSessionEvent(type, sessionId, payload, { turnId }),
    timestamp: new Date(time),
  };
}

function initial() {
  return reduce([event(E.SessionCreated, { mode: "build", contextWindow: 100_000 })]);
}

function intent(id: string): TurnInputIntentMetadata {
  return {
    sourceCommandId: id,
    queueItemId: id,
    clientId: "client",
    kind: "sendText",
    admissionSeq: 1,
    admittedAt: 1,
    requestedDelivery: "guide",
    admittedDelivery: "guide",
    mode: "build",
  };
}

function queued(id: string, time = 2) {
  return event(
    E.TurnSteerQueued,
    {
      pendingInputId: id,
      input: id,
      inputPreview: id,
      inputSize: id.length,
      targetTurnId: turnId,
      commandKind: "sendText",
      intent: intent(id),
      toolDisallowlist: ["Write"],
    },
    time,
  );
}

test("reducer public helpers preserve ordered lifecycle and stale-error clearing", () => {
  const created = event(E.SessionCreated, { mode: "plan", contextWindow: 4096 });
  const error = event(
    E.TurnError,
    {
      error: {
        type: "provider",
        code: "denied",
        message: "unavailable",
        detail: "provider detail",
        attribution: { category: "provider" },
      },
    },
    2,
  );
  const failed = reduce([created, error]);
  assert.equal(failed.planEnabled, true);
  assert.equal(failed.lastError?.code, "denied");
  assert.deepEqual(failed.lastError?.attribution, { category: "provider" });
  const started = event(E.TurnStarted, {}, 3);
  const resumed = apply(failed, started);
  assert.equal(resumed.lastError, undefined);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.turnCount, 1);
  assert.equal(resumed.currentTurnId, turnId);
  assert.deepEqual(new EventReducer().reduce([created, error, started]), resumed);
  const completed = apply(resumed, event(E.TurnComplete, { tokenCount: 12 }, 4));
  assert.equal(completed.status, "idle");
  assert.equal(completed.totalTokenCount, 12);
  assert.equal(failed.status, "error");
  assert.equal(reduce([]).id, "unknown");
});

test("model context ignores sidecars and legacy tool-internal results", () => {
  const start = initial();
  for (const payload of [
    { querySource: "compact", stopReason: "stop" },
    { querySource: "session_title", stopReason: "stop" },
    { stopReason: "tool_internal" },
  ]) {
    const result = apply(
      start,
      event(E.ModelComplete, {
        ...payload,
        content: "",
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    );
    assert.equal(result.contextUsed, 0);
  }
  for (const querySource of [undefined, "main_turn"]) {
    const result = apply(
      start,
      event(E.ModelComplete, {
        querySource,
        stopReason: "stop",
        content: "",
        usage: { inputTokens: 100, cacheReadTokens: 70, outputTokens: 20 },
      }),
    );
    assert.equal(result.contextUsed, 120);
  }
});

test("queue edits preserve admission position, time and metadata without mutating input", () => {
  const original = reduce([queued("one", 2), queued("two", 3)]);
  const before = structuredClone(original);
  const edited = apply(
    original,
    event(
      E.TurnSteerQueued,
      {
        pendingInputId: "one",
        input: "edited",
        inputPreview: "edited",
        inputSize: 6,
        targetTurnId: turnId,
      },
      4,
    ),
  );
  assert.deepEqual(original, before);
  assert.deepEqual(
    edited.pendingSteerInputs.map((item) => item.pendingInputId),
    ["one", "two"],
  );
  assert.equal(edited.pendingSteerInputs[0]?.queuedAt.getTime(), 2);
  assert.equal(edited.pendingSteerInputs[0]?.commandKind, "sendText");
  assert.deepEqual(edited.pendingSteerInputs[0]?.toolDisallowlist, ["Write"]);
  const delivered = apply(
    edited,
    event(E.TurnSteerDeliveryChanged, {
      pendingInputId: "one",
      admittedDelivery: "queue",
      fallbackReasonCode: "turn_ended",
    }),
  );
  assert.equal(delivered.pendingSteerInputs[0]?.intent?.admittedDelivery, "queue");
  const granted = apply(
    delivered,
    event(E.SessionModeChanged, {
      mode: "yolo",
      permissionGrant: { queueItemIds: ["one"] },
    }),
  );
  assert.equal(granted.pendingSteerInputs[0]?.intent?.mode, "yolo");
  assert.equal(granted.pendingSteerInputs[1]?.intent?.mode, "build");
  const reordered = apply(
    granted,
    event(E.TurnSteerReordered, {
      orderedPendingInputIds: ["missing", "two"],
    }),
  );
  assert.deepEqual(
    reordered.pendingSteerInputs.map((item) => item.pendingInputId),
    ["two", "one"],
  );
  assert.deepEqual(
    reordered.pendingSteerInputs.map((item) => item.intent?.queuePosition),
    [0, 1],
  );
  const drained = apply(reordered, event(E.TurnSteerDrained, { pendingInputIds: ["two"] }));
  const discarded = apply(drained, event(E.TurnSteerDiscarded, { pendingInputIds: ["one"] }));
  assert.deepEqual(discarded.pendingSteerInputs, []);
});

test("tool, permission and batch projections retain lifecycle distinctions", () => {
  let projection = apply(initial(), event(E.TurnStarted, {}));
  for (const toolCallId of ["first", "second"]) {
    projection = apply(projection, event(E.ToolCallScheduled, { toolCallId, toolName: "Read" }));
    projection = apply(
      projection,
      event(E.ToolCallStarted, { toolCallId, startedAt: new Date(2) }),
    );
    projection = apply(
      projection,
      event(E.PermissionRequested, {
        toolCallId,
        toolName: "Read",
        riskLevel: "low",
        optionsPolicy: { allowAlways: false },
      }),
    );
  }
  assert.equal(projection.pendingPermissions.length, 2);
  projection = apply(
    projection,
    event(E.PermissionResolved, { toolCallId: "first", decision: "allow" }),
  );
  projection = apply(projection, event(E.PermissionDenied, { toolCallId: "second" }));
  assert.deepEqual(
    projection.activeToolCalls.map((item) => item.status),
    ["completed", "denied"],
  );
  assert.deepEqual(projection.pendingPermissions, []);
  projection = apply(
    projection,
    event(E.ToolCallResult, { toolCallId: "first", result: { success: false } }),
  );
  projection = apply(projection, event(E.ToolCallError, { toolCallId: "second" }));
  assert.deepEqual(
    projection.activeToolCalls.map((item) => item.status),
    ["failed", "failed"],
  );
  projection = apply(projection, event(E.ToolBatchComplete, { toolCallIds: ["first", "second"] }));
  assert.deepEqual(projection.activeToolCalls, []);
  assert.equal(projection.status, "running");
});

test("background and stream recovery projections preserve prior facts", () => {
  const start = apply(
    initial(),
    event(
      E.BackgroundTaskStarted,
      {
        taskId: "task",
        status: "running",
        command: "test",
        stdoutBytes: 1,
      },
      2,
    ),
  );
  const updated = apply(
    start,
    event(
      E.BackgroundTaskUpdated,
      {
        taskId: "task",
        status: "running",
        stdoutBytes: 5,
        command: undefined,
      },
      3,
    ),
  );
  const done = apply(
    updated,
    event(E.BackgroundTaskCompleted, { taskId: "task", status: "completed" }, 4),
  );
  assert.equal(done.backgroundTasks[0]?.command, "test");
  assert.equal(done.backgroundTasks[0]?.stdoutBytes, 5);
  assert.equal(done.backgroundTasks[0]?.completedAt?.getTime(), 4);
  const ledger = apply(
    done,
    event(E.StreamingToolLedgerUpdated, {
      attemptId: "attempt",
      toolCallId: "tool",
      status: "tool_started",
      toolName: "Read",
    }),
  );
  const committed = apply(
    ledger,
    event(E.StreamingToolLedgerUpdated, {
      attemptId: "attempt",
      toolCallId: "tool",
      status: "tool_result_committed",
      recoveryAnchorId: "anchor",
    }),
  );
  assert.equal(committed.streamingToolLedger.length, 1);
  assert.equal(committed.streamingToolLedger[0]?.toolName, "Read");
  const anchored = apply(
    committed,
    event(E.StreamRecoveryAnchorCreated, {
      anchorId: "anchor",
      attemptId: "attempt",
      kind: "tool_result",
      committedToolCallIds: ["tool"],
    }),
  );
  assert.equal(anchored.lastStreamRecoveryAnchor?.anchorId, "anchor");
});

test("compact and rewind validation remain strict and unhandled events only advance time", () => {
  const start = initial();
  assert.throws(() => apply(start, event(E.CompactBoundary, {})));
  assert.throws(() => apply(start, event(E.CheckpointCreated, {})));
  assert.throws(() => apply(start, event(E.RewindTriggered, {})));
  const compacted = apply(
    start,
    event(
      E.SessionCompacted,
      {
        compactBoundary: {
          boundaryId: "boundary",
          trigger: "manual",
          preCompactTokenCount: 100,
          postCompactTokenCount: 40,
          truePostCompactTokenCount: 30,
          summarizedMessageCount: 3,
          traceId: "trace",
          summaryMessageIds: [],
        },
      },
      2,
    ),
  );
  assert.equal(compacted.contextUsed, 30);
  const checkpoint = apply(
    compacted,
    event(
      E.CheckpointCreated,
      {
        checkpointId: "checkpoint",
        messageId: "message",
        scope: "both",
        snapshotRef: "snapshot",
      },
      3,
    ),
  );
  assert.equal(checkpoint.lastCheckpoint?.checkpointId, "checkpoint");
  const rewound = apply(
    checkpoint,
    event(
      E.RewindTriggered,
      {
        rewindId: "rewind",
        scope: "conversation",
        strategy: "active_chain",
        targetMessageId: "message",
      },
      4,
    ),
  );
  assert.equal(rewound.lastRewind?.targetMessageId, "message");
  const unhandled = apply(rewound, event(E.SessionEnded, {}, 5));
  assert.deepEqual(unhandled, { ...rewound, updatedAt: new Date(5) });
});
