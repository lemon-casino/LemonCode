import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import type { RoutedTopicWireFrame } from "@lcode/shared/lcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "./v4-gateway.js";

function event(sequenceNumber: number, sessionId = "session-one"): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    type: SessionEventType.SessionTitleUpdated,
    sessionId,
    traceId: "trace-one",
    timestamp: new Date(1_000 + sequenceNumber),
    sequenceNumber,
    payload: { title: `Title ${sequenceNumber}` },
  } as SessionEvent;
}

function fixture(overrides: Partial<V4GatewayHost> = {}) {
  const wires: RoutedTopicWireFrame[] = [];
  const gateway = new ConversationV4Gateway(
    {
      sessionExists: () => true,
      emitWireFrame: (wire) => wires.push(wire),
      executeCommand: async () => undefined,
      ...overrides,
    },
    { now: () => 1_000, createLogEpoch: () => "epoch-one" },
  );
  return { gateway, wires };
}

const subscribeParams = {
  topic: "conversation/session-one",
  connectionId: "connection-one",
  clientMode: "desktop-continuous",
};

test("gateway preserves all public method arities at its original entrypoint", () => {
  const expected = {
    updateSharedContextImport: 2,
    setConnectionFlowState: 1,
    ingest: 2,
    waitForProjectionEventCommit: 2,
    waitForPermissionGrantCommit: 2,
    ingestDetachedLiveSession: 3,
    pruneDetachedChildPublishers: 0,
    subscribeSessionsIndex: 1,
    subscribeSessionsIndexReserved: 1,
    subscribeWorkspaceConfig: 1,
    subscribeWorkspaceConfigReserved: 1,
    publishWorkspaceConfig: 2,
    subscribe: 1,
    subscribeReserved: 1,
    resyncReserved: 1,
    rowsRange: 1,
    plans: 1,
    workflowRunEvents: 1,
    workflowRuns: 1,
    workflowRunArtifacts: 1,
    workflowRunArtifactData: 1,
    workflowRunArtifactRead: 1,
    workflowRunWorkspace: 1,
    workflowRunNodeResult: 1,
    fileChanges: 1,
    backgroundBashOutput: 1,
    fileRewindPreview: 1,
    attachmentBegin: 1,
    attachmentChunk: 1,
    attachmentCommit: 1,
    attachmentAbort: 1,
    attachmentRead: 1,
    conversationAttachmentRead: 1,
    conversationAttachmentStat: 1,
    attachmentPreviewSource: 1,
    unsubscribe: 1,
    handleCommand: 1,
    queryCommands: 1,
    getQueueItem: 2,
    hasQueueItemKind: 2,
    hasQueuedDelivery: 2,
    getQueueLength: 1,
    hasResidencyBlockingCommands: 1,
    getQueueHead: 1,
    getInputRoutingMode: 1,
    getSessionFollowupMode: 1,
    getMessageIdForRow: 2,
    resolveRowActionTarget: 3,
    getMessageIdsForTurnRow: 2,
    isLatestAssistantSegmentRow: 2,
    resolveStableForkCandidate: 2,
    isLatestRetryAssistantRow: 2,
    isLatestEditableUserRow: 2,
    getTurnIdForRow: 2,
    getTurnRewindAnchor: 2,
    disposeSession: 1,
    deactivateSession: 1,
    assertSessionRuntimeDeactivatable: 1,
    hasConversationSubscribers: 1,
    collectMemoryDiagnostics: 0,
    dispose: 0,
    flushNow: 1,
  } satisfies Record<keyof ConversationV4Gateway, number>;
  for (const [name, arity] of Object.entries(expected)) {
    const method = ConversationV4Gateway.prototype[name as keyof ConversationV4Gateway];
    assert.equal(method.length, arity, name);
  }
  assert.equal(ConversationV4Gateway.length, 1);
});

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`${clientMode}: initial ACK admission precedes online wires and retains owner`, async () => {
    const { gateway, wires } = fixture();
    try {
      const initial = await gateway.subscribeReserved({ ...subscribeParams, clientMode });
      assert.ok(initial.initialWires.length > 0);
      gateway.ingest("session-one", event(1));
      gateway.setConnectionFlowState({ connectionId: "connection-one", state: "saturated" });
      gateway.setConnectionFlowState({ connectionId: "connection-one", state: "drained" });
      assert.equal(wires.length, 0);
      assert.throws(
        () =>
          gateway.resyncReserved({
            topic: subscribeParams.topic,
            connectionId: "other-connection",
            subscriptionId: initial.ack.subscriptionId,
            base: null,
          }),
        /notOwned/,
      );
      assert.equal(initial.commit(), true);
      gateway.setConnectionFlowState({ connectionId: "connection-one", state: "saturated" });
      gateway.setConnectionFlowState({ connectionId: "connection-one", state: "drained" });
      assert.ok(wires.length > 0);
      assert.ok(wires.every((wire) => wire.deliveryKind === "online"));
      gateway.unsubscribe({
        topic: subscribeParams.topic,
        connectionId: "other-connection",
        subscriptionId: initial.ack.subscriptionId,
      });
      assert.equal(gateway.hasConversationSubscribers("session-one"), true);
      const recovery = gateway.resyncReserved({
        topic: subscribeParams.topic,
        connectionId: subscribeParams.connectionId,
        subscriptionId: initial.ack.subscriptionId,
        base: { logEpoch: "epoch-one", seq: 0 },
      });
      assert.equal(recovery.ack.subscriptionId, initial.ack.subscriptionId);
      assert.ok(recovery.initialWires.every((wire) => wire.deliveryKind === "recovery"));
      assert.equal(recovery.commit(), true);
    } finally {
      gateway.dispose();
    }
  });
}

test("raw gaps drain in order and an aborted commit cannot later become canonical", async () => {
  const { gateway } = fixture();
  try {
    const subscribed = await gateway.subscribe(subscribeParams);
    gateway.ingest("session-one", event(2));
    const controller = new AbortController();
    const waiting = gateway.waitForProjectionEventCommit("session-one", "event-2", {
      signal: controller.signal,
    });
    const rejected = assert.rejects(waiting, /aborted/);
    controller.abort();
    await rejected;
    gateway.ingest("session-one", event(1));
    await gateway.waitForProjectionEventCommit("session-one", "event-1");
    await assert.rejects(gateway.waitForProjectionEventCommit("session-one", "event-2"), /aborted/);
    gateway.ingest("session-one", event(3));
    await gateway.waitForProjectionEventCommit("session-one", "event-3");
    const flushed = gateway.flushNow(subscribed.ack.subscriptionId);
    assert.equal(flushed?.fromSeq, 0);
    assert.equal(flushed?.toSeq, 3);
  } finally {
    gateway.dispose();
  }
});

test("detached child pruning snapshots the original map before reentrant callbacks", () => {
  let added = false;
  const { gateway } = fixture({
    sessionExists: () => false,
    onDebug: (message) => {
      if (!added && message.startsWith("release detached")) {
        added = true;
        gateway.ingestDetachedLiveSession("late-child", terminal("late-child"), "parent");
      }
    },
  });
  function terminal(sessionId: string): SessionEvent {
    return {
      ...event(1, sessionId),
      type: SessionEventType.TurnComplete,
      payload: { resultType: "success" },
    } as SessionEvent;
  }
  try {
    gateway.ingestDetachedLiveSession("first-child", terminal("first-child"), "parent");
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now() + 1_000, 0), 1);
    assert.equal(gateway.collectMemoryDiagnostics().detachedLive, 1);
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now() + 1_000, 0), 1);
    assert.equal(gateway.collectMemoryDiagnostics().detachedLive, 0);
  } finally {
    gateway.dispose();
  }
});
