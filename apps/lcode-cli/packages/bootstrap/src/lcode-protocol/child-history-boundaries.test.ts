import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import type { FileSystemPort, ToolArtifactStorePort } from "@lcode/contracts";
import { childHistoryFixture } from "./child-history-readonly.fixture.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createV4HydrationHost } from "./v4-bridge-hydration.js";
import { resolveConversationReader } from "./conversation-reader.js";
import { WORKTREE_BINDING_ENTRY } from "./worktree-execution.js";

test("observed publisher follows existing grace and subscription residency without a fake live record", async () => {
  const f = childHistoryFixture();
  const gateway = createConversationV4Gateway(f.context);
  try {
    const subscribed = await gateway.subscribe({
      topic: `conversation/${f.sessionId}`,
      connectionId: "fixture",
      clientMode: "desktop-continuous",
    });
    assert.equal(gateway.collectMemoryDiagnostics().detachedLive, 0);
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now(), 120_000), 0);
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now() + 120_001, 0), 0);
    gateway.unsubscribe({
      topic: `conversation/${f.sessionId}`,
      connectionId: "fixture",
      subscriptionId: subscribed.ack.subscriptionId,
    });
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now() + 120_001, 0), 1);
    assert.equal(gateway.collectMemoryDiagnostics().publishers, 0);
    await gateway.rowsRange({
      sessionId: f.sessionId,
      limit: 20,
      clientMode: "web-remote-replayable",
    });
    assert.equal(f.appCreations(), 0);
  } finally {
    gateway.dispose();
  }
});

test("remote child observation preserves attachment identity and rejects another identity on the same path even after READY", async () => {
  const f = childHistoryFixture();
  const identity = buildRemoteWorkspaceIdentity("/workspace", {
    kind: "docker",
    container: "fixture-a",
  });
  f.stored.workspaceID = identity;
  f.stored.path = "/workspace";
  f.stored.directory = "/workspace";
  const workspace = {
    workspacePath: "/workspace",
    workspaceIdentity: identity,
    workspaceKey: identity,
    remoteSessionId: "attachment-a",
  };
  const gateway = createConversationV4Gateway(f.context);
  try {
    const result = await gateway.subscribe({
      topic: `conversation/${f.sessionId}`,
      connectionId: "fixture",
      clientMode: "web-remote-replayable",
      workspace,
    });
    assert.ok(JSON.stringify(result).includes("attachment-a"));
    const other = buildRemoteWorkspaceIdentity("/workspace", {
      kind: "docker",
      container: "fixture-b",
    });
    await assert.rejects(
      gateway.subscribe({
        topic: `conversation/${f.sessionId}`,
        connectionId: "other",
        clientMode: "web-remote-replayable",
        workspace: { ...workspace, workspaceIdentity: other, workspaceKey: other },
      }),
      /workspaceMismatch/,
    );
    assert.equal(f.appCreations(), 0);
  } finally {
    gateway.dispose();
  }
});

test("worktree origin read uses the stored execution binding for file paths and checks the attachment generation", async () => {
  const f = childHistoryFixture();
  f.stored.workspaceID = "execution";
  f.stored.path = "checkout";
  const execution = {
    workspacePath: "checkout",
    workspaceIdentity: "execution",
    workspaceKey: "execution",
    executionBindingId: "fixture-binding",
    originWorkspacePath: "origin",
    originWorkspaceIdentity: "original",
    remoteSessionId: "attachment-a",
  };
  f.store.sessionEntries = async () => [{ type: WORKTREE_BINDING_ENTRY, data: execution }] as never;
  const reader = await resolveConversationReader(f.context, f.sessionId, {
    workspacePath: "origin",
    workspaceIdentity: "original",
    workspaceKey: "original",
    remoteSessionId: "attachment-a",
  });
  assert.equal(reader.workspace.workspacePath, "checkout");
  assert.equal(reader.workspace.executionBindingId, "fixture-binding");
  await assert.rejects(
    resolveConversationReader(f.context, f.sessionId, {
      ...execution,
      remoteSessionId: "attachment-b",
    }),
    /remoteSessionMismatch/,
  );
});

test("a missing model catalog leaves capacity unknown while transcript remains readable", async () => {
  const f = childHistoryFixture();
  f.context.deps.conversationReadPorts = {
    artifactStore: {} as ToolArtifactStorePort,
    fileSystemPort: {} as FileSystemPort,
    modelContextWindow: () => {
      throw new Error("fixture catalog unavailable");
    },
  };
  const loaded = await createV4HydrationHost(f.context, undefined).loadPersistedEvents!(
    f.sessionId,
  );
  assert.equal(loaded.usageSeed?.contextWindow.maxTokens, null);
  assert.ok(JSON.stringify(loaded.events).includes("saved child reply"));
});

test("checkpoint entry read failure cannot masquerade as an empty successful detail", async () => {
  const f = childHistoryFixture();
  f.store.sessionEntries = async () => {
    throw new Error("fixture entry read failed");
  };
  const gateway = createConversationV4Gateway(f.context);
  try {
    await assert.rejects(
      gateway.rowsRange({ sessionId: f.sessionId, limit: 20, clientMode: "desktop-continuous" }),
      /fixture entry read failed/,
    );
  } finally {
    gateway.dispose();
  }
});
