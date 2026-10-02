import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";

function projectionFacts(): SessionEvent[] {
  let sequenceNumber = 0;
  const event = (
    type: SessionEvent["type"],
    payload: unknown,
    turnId: string | undefined = "runtime-turn",
  ): SessionEvent => ({
    id: `event-${++sequenceNumber}` as SessionEvent["id"],
    sessionId: "session-one" as SessionEvent["sessionId"],
    traceId: "trace-one" as SessionEvent["traceId"],
    turnId: turnId as SessionEvent["turnId"],
    timestamp: new Date(sequenceNumber * 100),
    sequenceNumber,
    type,
    payload,
  });
  const stream = (kind: string, extra = {}) =>
    event(SessionEventType.ModelStreaming, {
      kind,
      delta: "",
      done: false,
      assistantMessageId: "assistant-one",
      ...extra,
    });
  const hook = {
    hookInvocationId: "hook-invocation",
    hookRunId: "hook-run",
    hookCount: 1,
    hookIndex: 0,
    hookEventName: "SessionStart",
    descriptor: {
      clientVisible: true,
      sourceKind: "plugin",
      pluginName: "test-plugin",
      commandDisplay: "node startup.mjs",
    },
  };
  const queuedIntent = {
    sourceCommandId: "queue-command",
    queueItemId: "queue-one",
    clientId: "test-client",
    kind: "sendText",
    text: "queued text",
    admissionSeq: 1,
    admittedAt: 1_000,
    requestedDelivery: "queue",
    admittedDelivery: "queue",
    modelSelection: { providerId: "test-provider", modelId: "test-model" },
    mode: "build",
    planEnabled: false,
    attachmentRefs: [],
  };
  const initialHook = event(SessionEventType.HookRunStarted, hook);
  delete initialHook.turnId;
  return [
    initialHook,
    event(SessionEventType.TurnStarted, {
      turnNumber: 1,
      messageId: "user-one",
      input: "first input",
    }),
    event(SessionEventType.HookRunCompleted, { ...hook, outcome: "success" }),
    event(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
      previousModelSelection: null,
      contextWindow: null,
    }),
    event(SessionEventType.ModelNetworkStatus, {
      type: "model_request_started",
      requestId: "request-one",
      querySource: "main_turn",
    }),
    stream("reasoning_delta", { delta: "thinking" }),
    stream("reasoning_end"),
    stream("text_delta", { delta: "answer" }),
    stream("text_end"),
    stream("tool_input_start", { toolCallId: "write-one", toolName: "Write" }),
    stream("tool_input_delta", { toolCallId: "write-one", delta: '{"content":"' }),
    stream("tool_input_delta", { toolCallId: "write-one", delta: "pending" }),
    stream("tool_input_delta", { toolCallId: "write-one", delta: '"}' }),
    stream("tool_input_end", { toolCallId: "write-one" }),
    event(SessionEventType.ToolCallScheduled, {
      toolCallId: "list-apps",
      toolName: "mcp__computer-use__list_apps",
      input: {},
    }),
    event(SessionEventType.ToolCallResult, {
      toolCallId: "list-apps",
      result: { success: true, content: '{"apps":[{"pid":42,"name":"Example"}]}' },
    }),
    event(SessionEventType.ToolCallScheduled, {
      toolCallId: "app-state",
      toolName: "mcp__computer-use__get_app_state",
      input: { app_ref: { pid: 42 } },
    }),
    event(SessionEventType.TurnSteerQueued, {
      pendingInputId: "queue-one",
      input: "queued text",
      queueLength: 1,
      delivery: "queue",
      intent: queuedIntent,
    }),
    event(SessionEventType.TurnSteerDrained, {
      pendingInputIds: ["queue-one"],
      drainedInputs: [
        {
          pendingInputId: "queue-one",
          messageId: "user-two",
          text: "queued text",
          delivery: "queue",
          intent: queuedIntent,
        },
      ],
    }),
    event(SessionEventType.SubagentSpawned, {
      agentId: "agent-one",
      childSessionId: "child-one",
      parentToolCallId: "agent-call",
      background: true,
      resumed: true,
      lifecycleId: "lifecycle-one",
      description: "child task",
    }),
    event(SessionEventType.SubagentMessage, { agentId: "agent-one", text: "progress" }),
    event(SessionEventType.BackgroundTaskResultConsumed, {
      workId: "agent-one",
      lifecycleId: "lifecycle-one",
      messageId: "notification-one",
      sourceCommandId: "notification-command",
      delivery: "activeLoop",
    }),
    event(SessionEventType.DynamicWorkflowRunProgress, {
      runId: "run-one",
      sequence: 1,
      eventType: "run-started",
      occurredAt: 1_000,
      payload: {},
    }),
    event(SessionEventType.ModelNetworkStatus, {
      type: "model_request_completed",
      requestId: "request-one",
      querySource: "main_turn",
      durationMs: 2_000,
      usage: { outputTokens: 100 },
    }),
    event(SessionEventType.ModelComplete, {
      content: "answer",
      querySource: "main_turn",
      stopReason: "stop",
      usage: { inputTokens: 200, outputTokens: 100 },
    }),
    event(SessionEventType.TurnComplete, { resultType: "success", duration: 10_000 }),
    event(SessionEventType.CompactCompleted, {
      operationId: "compact-one",
      status: "completed",
      trigger: "manual",
      anchorMessageId: "user-one",
      postCompactTokenCount: 10,
    }),
    event(SessionEventType.TargetCompletionVerification, {
      status: "started",
      verificationId: "verify-one",
      targetId: "target-one",
      goalIteration: 1,
      anchorTurnId: "runtime-turn",
    }),
    event(SessionEventType.TargetCompletionVerification, {
      status: "completed",
      verificationId: "verify-two",
      targetId: "target-one",
      goalIteration: 1,
      verification: { passed: true, reason: "done" },
    }),
    event(SessionEventType.RewindTriggered, {
      targetMessageId: "user-two",
      scope: "conversation",
      branchGeneration: 1,
      branchCutAfterMessageId: "assistant-one",
    }),
  ];
}

function seedProjection(projection: ProductProjection): void {
  projection.seedConfig({ provider: "test-provider", model: "test-model", thought: "" });
  // additive 字段必须继续透传；拆分不能靠重新枚举 schema 来重建 snapshot/usage。
  Object.assign(projection.getSnapshot(), { futureSnapshotField: { value: "opaque" } });
  Object.assign(projection.getSnapshot().usage, { futureUsageField: { value: "opaque" } });
}

test("atomic rejection leaves snapshot and borrowed mutable state unchanged before acceptance", () => {
  const live = new ProductProjection("session-one", "epoch-one");
  const atomic = new ProductProjection("session-one", "epoch-one");
  seedProjection(live);
  seedProjection(atomic);
  let delivered = structuredClone(live.getSnapshot());
  for (const event of projectionFacts()) {
    const original = atomic.getSnapshot();
    const before = structuredClone(original);
    const diagnostics = [...atomic.getNormalizationDiagnostics()];
    assert.equal(
      atomic.applyEventAtomically(event, () => false),
      null,
      event.type,
    );
    assert.strictEqual(atomic.getSnapshot(), original, event.type);
    assert.deepEqual(original, before, event.type);
    assert.deepEqual(atomic.getNormalizationDiagnostics(), diagnostics, event.type);
    const expected = live.applyEvent(event);
    const actual = atomic.applyEventAtomically(event, () => true);
    assert.deepEqual(actual, expected, event.type);
    assert.deepEqual(atomic.getSnapshot(), live.getSnapshot(), event.type);
    delivered = {
      ...applyConversationDeltas(delivered, expected),
      seq: event.sequenceNumber,
    };
    assert.deepEqual(atomic.getSnapshot(), delivered, event.type);
  }
});

test("hydration and live materialization keep row targets, product turns and opaque fields", () => {
  const live = new ProductProjection("session-one", "epoch-one");
  const cold = new ProductProjection("session-one", "epoch-one");
  seedProjection(live);
  seedProjection(cold);
  cold.beginHydrationReplay();
  for (const event of projectionFacts()) {
    live.applyEvent(event);
    cold.applyHydrationEvent(event);
  }
  cold.completeHydrationReplay();
  assert.deepEqual(cold.getSnapshot(), live.getSnapshot());
  for (const row of live.getSnapshot().rows.window) {
    assert.equal(cold.getEntityIdForRow(row.rowId), live.getEntityIdForRow(row.rowId));
    assert.equal(cold.getMessageIdForRow(row.rowId), live.getMessageIdForRow(row.rowId));
    assert.deepEqual(cold.resolveEditTarget(row.rowId), live.resolveEditTarget(row.rowId));
    assert.deepEqual(
      cold.getMessageIdsForTurnRow(row.rowId),
      live.getMessageIdsForTurnRow(row.rowId),
    );
    assert.deepEqual(
      cold.resolveStableForkCandidate(row.rowId),
      live.resolveStableForkCandidate(row.rowId),
    );
  }
});

test("seed usage preserves request statistics and unknown additive state", () => {
  const projection = new ProductProjection("session-one", "epoch-one");
  seedProjection(projection);
  const modelOutput = {
    turnId: "turn-one",
    activeRequestId: null,
    lastRequest: {
      requestId: "request-one",
      outputTokens: 100,
      durationMs: 2_000,
      completedAt: 10,
    },
  };
  Object.assign(projection.getSnapshot().usage, { modelOutput });
  projection.seedUsage({
    contextWindow: { usedTokens: 5, maxTokens: 100, autoCompactThresholdTokens: null },
    cumulative: { inputTokens: 5 },
  });
  assert.equal(projection.getSnapshot().usage.modelOutput, modelOutput);
  const usage = projection.getSnapshot().usage as ConversationSnapshot["usage"] & {
    futureUsageField: { value: string };
  };
  assert.deepEqual(usage.futureUsageField, { value: "opaque" });
});

test("ProductProjection retains public prototype methods and callable arity", () => {
  const arities = {
    getSnapshot: 0,
    getDroppedContentStreamEventCount: 0,
    getNormalizationDiagnostics: 0,
    establishedStreamingAppend: 1,
    seedConfig: 1,
    seedSharedContextImport: 1,
    seedUsage: 1,
    seedSubagents: 1,
    getMessageIdForRow: 1,
    getEntityIdForRow: 1,
    resolveEditTarget: 1,
    resolveEditTargetByEntityId: 1,
    resolveRowActionTarget: 2,
    getMessageIdsForTurnRow: 1,
    isLatestAssistantSegmentRow: 1,
    resolveStableForkCandidate: 1,
    isLatestRetryAssistantRow: 1,
    isLatestEditableUserRow: 1,
    getTurnIdForRow: 1,
    getTurnRewindAnchor: 1,
    applyEvent: 1,
    beginHydrationReplay: 0,
    applyHydrationEvent: 1,
    completeHydrationReplay: 0,
    applyEventAtomically: 2,
  };
  for (const [name, arity] of Object.entries(arities)) {
    const descriptor = Object.getOwnPropertyDescriptor(ProductProjection.prototype, name);
    assert.equal(typeof descriptor?.value, "function", name);
    assert.equal(descriptor?.value.length, arity, name);
  }
  assert.equal(ProductProjection.length, 2);
});
