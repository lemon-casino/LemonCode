import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  contextCapsuleSourcePayload,
  type ContextCapsule,
  type CreateSessionInput,
  type MessageWithParts,
  type SessionId,
  type MessageId,
  type PartId,
  type TurnId,
} from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("capsules survive SQLite reopen while a fork retains historical refs without migrating target ownership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capsule-lifecycle-")),
    dbPath = join(directory, "session.sqlite");
  let store = createSqliteSessionStore({ dbPath });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessionInput = (id: string): CreateSessionInput =>
    ({
      id,
      directory,
      projectID: "project",
      taskType: "interactive",
      title: id,
      slug: id,
      version: "1",
    }) as CreateSessionInput;
  for (const id of ["source", "target"]) await store.createSession(sessionInput(id));
  const source = {
    info: {
      id: "source-assistant",
      sessionID: "source",
      role: "assistant",
      agent: "build",
      parentID: "source-user",
      mode: "build",
      time: { created: 1, completed: 2 },
      finish: "stop",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "source-part",
        messageID: "source-assistant",
        sessionID: "source",
        type: "text",
        text: "stable handoff result",
      },
    ],
  } as MessageWithParts;
  const capsuleId = `capsule_${hash("target\noperation").slice(0, 32)}`;
  const refs = [{ kind: "context_capsule" as const, capsule_id: capsuleId }];
  const user = {
    info: {
      id: "target-user" as MessageId,
      sessionID: "target" as SessionId,
      role: "user",
      agent: "build",
      time: { created: 3 },
      anchor: { origin: "realUser", turnId: "target-turn" as TurnId },
      metadata: { conversationInputIntent: { contextCapsuleRefs: refs } },
    },
    parts: [
      {
        id: "target-part" as PartId,
        messageID: "target-user" as MessageId,
        sessionID: "target" as SessionId,
        type: "text",
        text: `explicit handoff\n#${capsuleId}`,
      },
    ],
  } as MessageWithParts;
  for (const message of [source, user]) {
    await store.saveMessage(message.info);
    for (const part of message.parts) await store.savePart(part);
  }
  const sourceSession = (await store.getSession("source" as SessionId))!,
    targetSession = (await store.getSession("target" as SessionId))!;
  const content = "saved bounded background";
  const capsule: ContextCapsule = {
    schemaVersion: 1,
    id: capsuleId,
    sourceSessionId: "source",
    targetSessionId: "target",
    sourceScope: { directory: sourceSession.directory, path: sourceSession.path },
    targetScope: { directory: targetSession.directory, path: targetSession.path },
    sourceBoundaryMessageId: source.info.id,
    sourceMessageIds: [source.info.id],
    sourceVersion: hash(
      contextCapsuleSourcePayload(
        sourceSession,
        await store.messages({ sessionID: sourceSession.id }),
      ),
    ),
    content,
    contentSha256: hash(content),
    strategy: "handoff",
    generatorVersion: "handoff-v1",
    truncated: false,
    createdAtMs: 4,
    targetMessageId: user.info.id,
    targetTurnId: "target-turn",
    operationId: "operation",
    references: [{ messageId: source.info.id }],
  };
  assert.equal((await store.commitContextCapsule(capsule)).status, "committed");
  store.close();
  store = createSqliteSessionStore({ dbPath });
  assert.equal(
    (await store.readContextCapsule({ sessionId: "target" as SessionId, capsuleId }))?.content,
    content,
  );
  assert.deepEqual(
    (await store.messages({ sessionID: "target" as SessionId }))[0]?.info.metadata
      ?.conversationInputIntent,
    { contextCapsuleRefs: refs },
  );
  const childUser = {
    info: {
      ...user.info,
      id: "child-user",
      sessionID: "child",
      anchor: { origin: "realUser", turnId: "child-turn" },
    },
    parts: user.parts.map((part) => ({
      ...part,
      id: "child-part",
      messageID: "child-user",
      sessionID: "child",
    })),
  } as MessageWithParts;
  await store.commitForkBundle({
    child: { ...sessionInput("child"), parentID: "target" as SessionId },
    messages: [childUser],
    entries: [],
    commandFact: {
      parentSessionId: "target",
      sourceCommandId: "fork-command",
      ack: {
        commandId: "fork-command",
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: "child" },
      },
      metadata: {},
    },
  });
  assert.deepEqual(
    (await store.messages({ sessionID: "child" as SessionId }))[0]?.info.metadata
      ?.conversationInputIntent,
    { contextCapsuleRefs: refs },
  );
  assert.equal(
    await store.readContextCapsule({ sessionId: "child" as SessionId, capsuleId }),
    undefined,
  );
  assert.equal(
    (
      await store.sessionEntries({
        sessionID: "child" as SessionId,
        type: "runtime/context_capsule",
      })
    ).length,
    0,
  );
  await store.saveSessionInput({
    id: "child-retry",
    sessionID: "child" as SessionId,
    kind: "sendText",
    delivery: "startNow",
    payload: { text: "retry", intent: { contextCapsuleRefs: refs } },
  });
  await store.promoteSessionInput({
    id: "child-retry",
    sessionID: "child" as SessionId,
    message: childUser.info,
    parts: childUser.parts,
  });
  assert.equal(
    await store.attachContextCapsulesToInput({
      sessionId: "child",
      inputId: "child-retry",
      targetMessageId: "child-user",
      targetTurnId: "child-turn",
      capsuleIds: [capsuleId],
      expectedScope: { directory },
    }),
    false,
  );
});
