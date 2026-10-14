import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SESSION_ENTRY_WORKSPACE_FILE_REWIND } from "@lcode/contracts";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createV4ReadHost } from "./v4-bridge-read-host.js";
import { childFileRewindFixture } from "./child-file-rewind.fixture.js";
import { applyHistoricalConversationFileRewind } from "./conversation-file-rewind.js";
import { childHistoryFixture } from "./child-history-readonly.fixture.js";

test("cold child file summaries and previews read durable checkpoints without changing files", async () => {
  const f = childFileRewindFixture();
  const host = createV4ReadHost(f.context);
  const summary = await host.getConversationFileChanges!(f.sessionId, 1, ["user"], "turn" as never);
  const preview = await host.previewConversationFileRewind!(
    f.sessionId,
    1,
    ["user"],
    "turn" as never,
  );
  assert.ok(JSON.stringify(summary).includes("one.txt"));
  assert.equal(preview.canApply, true);
  assert.equal(f.writes.length, 0);
  assert.equal(f.appCreations(), 0);
});

test("explicit child file rewind preserves the existing inbox/row guards and changes no execution identity", async () => {
  const f = childFileRewindFixture();
  const gateway = createConversationV4Gateway(f.context);
  f.context.v4Gateway = gateway;
  try {
    const rows = await gateway.rowsRange({
      sessionId: f.sessionId,
      limit: 20,
      clientMode: "desktop-continuous",
    });
    const snapshot = (
      gateway as unknown as { state: { publishers: Map<string, { getSnapshot(): any }> } }
    ).state.publishers
      .get(f.sessionId)!
      .getSnapshot();
    const header = rows.rows.find((row: any) => row.kind === "turnHeader");
    assert.ok(
      header,
      JSON.stringify(
        rows.rows.map((row: any) => ({ kind: row.kind, type: row.type, rowId: row.rowId })),
      ),
    );
    const envelope = {
      commandId: randomUUID(),
      clientId: "fixture",
      issuedAt: 1,
      sessionId: f.sessionId,
      type: "applyFileRewind",
      payload: { target: { rowId: header.rowId, entityId: header.entityId } },
      baseRevision: snapshot.revision,
      baseLogEpoch: snapshot.logEpoch,
    };
    const stale = await gateway.handleCommand({
      ...envelope,
      commandId: randomUUID(),
      baseLogEpoch: "old",
    });
    assert.equal(stale.status, "stale");
    assert.equal(f.writes.length, 0);
    const ack = await gateway.handleCommand(envelope);
    assert.equal(ack.status, "accepted", JSON.stringify(ack));
    assert.equal(f.content(), "before");
    assert.ok(f.entries.some((entry) => entry.type === SESSION_ENTRY_WORKSPACE_FILE_REWIND));
    assert.equal(f.appCreations(), 0);
    assert.equal(f.context.sessions.size, 0);
    await gateway.handleCommand(envelope);
    assert.equal(f.writes.length, 1, "duplicate command cannot replay file writes");
  } finally {
    gateway.dispose();
  }
});

test("a failed durable rewind receipt compensates files and leaves no false reverted fact", async () => {
  const f = childFileRewindFixture();
  f.store.saveSessionEntry = async () => {
    throw new Error("fixture durable receipt failed");
  };
  await assert.rejects(
    applyHistoricalConversationFileRewind(f.context, f.sessionId, {
      targetMessageIds: ["user" as never],
      targetTurnId: "turn" as never,
    }),
    /fixture durable receipt failed/,
  );
  assert.equal(f.content(), "after");
  assert.deepEqual(f.writes, ["before", "after"]);
  assert.equal(
    f.entries.filter((entry) => entry.type === SESSION_ENTRY_WORKSPACE_FILE_REWIND).length,
    0,
  );
});

test("observed child pruning waits for its admitted file action to settle", async () => {
  const f = childFileRewindFixture();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = f.store.saveSessionEntry!;
  f.store.saveSessionEntry = async (entry) => {
    if (entry.type === SESSION_ENTRY_WORKSPACE_FILE_REWIND) {
      entered();
      await gate;
    }
    await save(entry);
  };
  const gateway = createConversationV4Gateway(f.context);
  f.context.v4Gateway = gateway;
  try {
    const rows = await gateway.rowsRange({
      sessionId: f.sessionId,
      limit: 20,
      clientMode: "desktop-continuous",
    });
    const snapshot = (
      gateway as unknown as { state: { publishers: Map<string, { getSnapshot(): any }> } }
    ).state.publishers
      .get(f.sessionId)!
      .getSnapshot();
    const header = rows.rows.find((row: any) => row.kind === "turnHeader")!;
    const pending = gateway.handleCommand({
      commandId: randomUUID(),
      clientId: "fixture",
      issuedAt: 1,
      sessionId: f.sessionId,
      type: "applyFileRewind",
      payload: { target: { rowId: header.rowId, entityId: header.entityId } },
      baseRevision: snapshot.revision,
      baseLogEpoch: snapshot.logEpoch,
    });
    await enteredPromise;
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now() + 120_001, 0), 0);
    release();
    assert.equal((await pending).status, "accepted");
    assert.equal(gateway.pruneDetachedChildPublishers(Date.now() + 120_001, 0), 1);
  } finally {
    release();
    gateway.dispose();
  }
});

test("cold child feedback keeps canonical row checks and never creates an execution runtime", async () => {
  const f = childHistoryFixture();
  f.store.saveMessage = async (info) => {
    f.messages[1].info = info;
  };
  f.store.saveSessionEntry = async () => {};
  const gateway = createConversationV4Gateway(f.context);
  f.context.v4Gateway = gateway;
  try {
    const rows = await gateway.rowsRange({
      sessionId: f.sessionId,
      limit: 20,
      clientMode: "web-remote-replayable",
    });
    const snapshot = (
      gateway as unknown as { state: { publishers: Map<string, { getSnapshot(): any }> } }
    ).state.publishers
      .get(f.sessionId)!
      .getSnapshot();
    const assistant = rows.rows.find((row) => row.kind === "assistantText");
    assert.ok(assistant);
    const ack = await gateway.handleCommand({
      commandId: randomUUID(),
      clientId: "fixture",
      issuedAt: 1,
      sessionId: f.sessionId,
      type: "setAssistantFeedback",
      payload: {
        target: { rowId: assistant.rowId, entityId: assistant.entityId },
        feedback: "like",
      },
      baseRevision: snapshot.revision,
      baseLogEpoch: snapshot.logEpoch,
    });
    assert.equal(ack.status, "accepted", JSON.stringify(ack));
    assert.equal(f.messages[1].info.metadata?.assistantFeedback, "like");
    assert.equal(f.appCreations(), 0);
    assert.equal(f.context.sessions.size, 0);
  } finally {
    gateway.dispose();
  }
});
