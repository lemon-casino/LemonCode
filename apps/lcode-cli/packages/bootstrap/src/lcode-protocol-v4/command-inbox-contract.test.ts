import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  ConversationInputIntent,
} from "@lcode/shared/lcode-protocol-v4";
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

test("failed worktree preparation permits only explicit same-command setup retry", async () => {
  const inbox = fixture();
  const payload: CommandPayloadMap["createSession"] = {
    workspaceId: "/origin",
    execution: { mode: "worktree", baseRef: "main" },
    firstInput: { text: "preserve this first input" },
  };
  const create: CommandEnvelope = {
    ...command("create-tree"),
    type: "createSession",
    sessionId: null,
    payload,
  };
  const first = await inbox.handle(create);
  assert.equal(first.kind, "execute");
  if (first.kind !== "execute") return;
  first.settle({ status: "failed", reasonCode: "fault.command.worktreePreparationFailed" });
  const automaticRetry = await inbox.handle(create);
  assert.equal(automaticRetry.kind, "ack");
  if (automaticRetry.kind === "ack") assert.equal(automaticRetry.ack.status, "failed");
  const changedBase = await inbox.handle({
    ...create,
    payload: { ...payload, execution: { mode: "worktree", baseRef: "other", retrySetup: true } },
  });
  assert.equal(changedBase.kind, "ack");
  const retry = await inbox.handle({
    ...create,
    payload: { ...payload, execution: { mode: "worktree", baseRef: "main", retrySetup: true } },
  });
  assert.equal(retry.kind, "execute");
  if (retry.kind !== "execute") return;
  assert.equal(retry.envelope.commandId, create.commandId);
  assert.deepEqual(
    (retry.envelope.payload as CommandPayloadMap["createSession"]).firstInput,
    payload.firstInput,
  );
  retry.settle({
    status: "accepted",
    result: { type: "createSession", sessionId: "same-tree-task" },
  });
  const afterSuccess = await inbox.handle(create);
  assert.equal(afterSuccess.kind, "ack");
  if (afterSuccess.kind === "ack")
    assert.deepEqual(afterSuccess.ack.result, {
      type: "createSession",
      sessionId: "same-tree-task",
    });
});

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
