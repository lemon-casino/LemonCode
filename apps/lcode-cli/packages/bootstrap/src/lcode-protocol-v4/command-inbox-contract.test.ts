import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, ConversationInputIntent } from "@lcode/shared/lcode-protocol-v4";
import { CommandInbox, queueItemIdForCommand } from "./command-inbox.js";

function command(commandId: string): CommandEnvelope {
  return {
    type: "sendText",
    commandId,
    sessionId: "session-one",
    clientId: "client-one",
    issuedAt: 1_000,
    payload: { text: commandId },
  };
}

function fixture() {
  return new CommandInbox({
    getRevision: () => 7,
    getLogEpoch: () => "epoch-one",
    now: () => 1_000,
  });
}

test("command inbox gates duplicates on the final ACK and preserves session FIFO", async () => {
  const inbox = fixture();
  const first = await inbox.handle(command("first"));
  assert.ok(first.kind === "execute");
  const duplicatePromise = inbox.handle(command("first"));
  const nextPromise = inbox.handle(command("next"));
  let nextAdmitted = false;
  void nextPromise.then(() => {
    nextAdmitted = true;
  });
  await Promise.resolve();
  assert.equal(nextAdmitted, false);
  first.settle({ status: "failed", reasonCode: "fixture.failure" });
  const duplicate = await duplicatePromise;
  assert.ok(duplicate.kind === "ack");
  assert.equal(duplicate.ack.status, "failed");
  assert.equal(duplicate.ack.reasonCode, "fixture.failure");
  const next = await nextPromise;
  assert.ok(next.kind === "execute");
  assert.equal(next.admissionSeq, first.admissionSeq + 1);
  next.settle({ status: "accepted" });
  const results = await inbox.query([
    { sessionId: "session-one", commandId: "next" },
    { sessionId: "session-one", commandId: "first" },
  ]);
  assert.deepEqual(
    results.map((result) => result.key.commandId),
    ["next", "first"],
  );
});

test("live input stays pinned across settled LRU churn and blocks clearSession", async () => {
  const inbox = fixture();
  const first = await inbox.handle(command("live"));
  assert.ok(first.kind === "execute");
  const intent: ConversationInputIntent = {
    sourceCommandId: "live",
    queueItemId: queueItemIdForCommand("live"),
    clientId: "client-one",
    kind: "sendText",
    text: "original",
    attachments: [],
    admittedAt: 1_000,
    order: { admissionSeq: first.admissionSeq, queuePosition: 0 },
    delivery: { requested: "queue", admitted: "queue" },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
  };
  inbox.pinLiveInput("session-one", intent);
  first.settle({ status: "accepted" });
  for (let index = 0; index < 520; index++) {
    const outcome = await inbox.handle(command(`settled-${index}`));
    assert.ok(outcome.kind === "execute");
    outcome.settle({ status: "accepted" });
  }
  assert.equal(inbox.clearSession("session-one"), false);
  const duplicate = await inbox.handle(command("live"));
  assert.ok(duplicate.kind === "ack");
  assert.equal(duplicate.ack.status, "duplicate");
  inbox.releaseLiveInput({ sessionId: "session-one", commandId: "live" });
  assert.equal(inbox.clearSession("session-one"), true);
});

test("row commands check epoch before revision and keep public arities", async () => {
  const inbox = fixture();
  const stale = await inbox.handle({
    ...command("edit"),
    type: "editUserQuery",
    baseRevision: 1,
    baseLogEpoch: "old-epoch",
    payload: { target: { rowId: 1, entityId: "entity-one" }, newText: "edited" },
  });
  assert.ok(stale.kind === "ack");
  assert.equal(stale.ack.reasonCode, "proto.staleLogEpoch");
  const expected = {
    handle: 1,
    query: 1,
    pinLiveInput: 3,
    releaseLiveInput: 2,
    hasPinnedSessionState: 1,
    clearSession: 1,
  };
  for (const [name, arity] of Object.entries(expected)) {
    assert.equal(CommandInbox.prototype[name as keyof typeof expected].length, arity, name);
  }
});
