import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  ContextCapsuleSchema,
  contextCapsuleSourcePayload,
  selectActiveSessionTranscript,
  stableContextMessages,
  type ContextCapsule,
  type CreateSessionInput,
  type MessageWithParts,
  type SessionId,
  type TurnInputIntentMetadata,
} from "@lcode/contracts";
import { createSqliteSessionStore, type SqliteSessionStore } from "../session-store.js";

const directory = resolve("capsule-workspace");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function user(id: string, sessionId: string, turnId: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      agent: "test",
      time: { created: 2 },
      anchor: { origin: "realUser", turnId },
    },
    parts: [
      {
        id: `part_${id}`,
        messageID: id,
        sessionID: sessionId,
        type: "text",
        text: "explicit handoff request",
      },
    ],
  } as MessageWithParts;
}
async function setup(t: test.TestContext) {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  for (const id of ["sess_source", "sess_target", "sess_other"])
    await store.createSession({
      id,
      projectID: "project",
      directory,
      taskType: "interactive",
      title: id,
      slug: id,
      version: "1",
    } as CreateSessionInput);
  const source: MessageWithParts = {
    info: {
      id: "msg_source",
      sessionID: "sess_source",
      role: "assistant",
      agent: "test",
      time: { created: 1, completed: 2 },
      finish: "stop",
      mode: "build",
      parentID: "msg_source_user",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "part_source",
        messageID: "msg_source",
        sessionID: "sess_source",
        type: "text",
        text: "stable branch result",
      },
    ],
  } as MessageWithParts;
  await store.saveMessage(source.info);
  for (const part of source.parts) await store.savePart(part);
  const target = user("msg_target", "sess_target", "turn_target");
  await store.saveMessage(target.info);
  for (const part of target.parts) await store.savePart(part);
  return { store, source, target };
}
async function capsule(store: SqliteSessionStore, operationId = "op-one"): Promise<ContextCapsule> {
  const source = (await store.getSession("sess_source" as SessionId))!,
    target = (await store.getSession("sess_target" as SessionId))!;
  const records = stableContextMessages(
    selectActiveSessionTranscript(await store.messages({ sessionID: source.id })),
  );
  const content = "bounded summary";
  const scope = (session: typeof source) => ({
    workspaceIdentity: session.workspaceID?.trim() || undefined,
    directory: session.directory,
    path: session.path,
  });
  return {
    schemaVersion: 1,
    id: `capsule_${hash(`sess_target\n${operationId}`).slice(0, 32)}`,
    sourceSessionId: source.id,
    sourceScope: scope(source),
    sourceBoundaryMessageId: records.at(-1)!.info.id,
    sourceMessageIds: records.map((message) => message.info.id),
    sourceVersion: hash(contextCapsuleSourcePayload(source, records)),
    content,
    contentSha256: hash(content),
    strategy: "handoff",
    generatorVersion: "handoff-v1",
    truncated: false,
    createdAtMs: 10,
    targetSessionId: target.id,
    targetScope: scope(target),
    targetMessageId: "msg_target",
    targetTurnId: "turn_target",
    operationId,
    references: [{ messageId: "msg_source" }],
  };
}

test("independent capsules commit once and reject changed source, target and cancelled requests", async (t) => {
  const { store, source } = await setup(t),
    first = await capsule(store),
    second = await capsule(store, "op-two");
  assert.equal((await store.commitContextCapsule(first)).status, "committed");
  assert.equal((await store.commitContextCapsule(first)).status, "reused");
  assert.equal((await store.commitContextCapsule(second)).status, "committed");
  assert.equal(
    (
      await store.sessionEntries({
        sessionID: "sess_target" as SessionId,
        type: "runtime/context_capsule",
      })
    ).length,
    2,
  );
  assert.equal(
    await store.readContextCapsule({ sessionId: "sess_other" as SessionId, capsuleId: first.id }),
    undefined,
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await store.commitContextCapsule(await capsule(store, "cancelled"), {
        signal: controller.signal,
      })
    ).status,
    "stale",
  );
  await store.savePart({
    ...source.parts[0]!,
    text: "source changed",
  } as MessageWithParts["parts"][number]);
  assert.equal(
    (
      await store.commitContextCapsule({
        ...first,
        operationId: "new",
        id: `capsule_${hash("sess_target\nnew").slice(0, 32)}`,
      })
    ).status,
    "stale",
  );
});

test("capsule transactions use the compact-preserved visible prefix and reject inserted history", async (t) => {
  const { store, source } = await setup(t);
  assert.equal(source.info.role, "assistant");
  await store.saveMessage({ ...source.info, time: { created: 1 } });
  const preserved = {
    ...source,
    info: { ...source.info, id: "msg_preserved", time: { created: 3, completed: 4 } },
    parts: [{ ...source.parts[0]!, id: "part_preserved", messageID: "msg_preserved" }],
  } as MessageWithParts;
  const compact = user("msg_compact", "sess_source", "turn_compact");
  compact.parts = [
    {
      id: "part_compact",
      messageID: compact.info.id,
      sessionID: "sess_source",
      type: "compaction",
      auto: false,
      compactBoundary: {
        boundaryId: "compact_1",
        trigger: "manual",
        preCompactTokenCount: 10,
        summarizedMessageCount: 1,
        summaryMessageIds: ["msg_summary"],
        traceId: "trace_compact",
        preservedSegment: {
          headMessageId: "msg_preserved",
          tailMessageId: "msg_preserved",
          anchorMessageId: "msg_compact",
        },
      },
    },
  ] as MessageWithParts["parts"];
  const summary = {
    ...source,
    info: {
      ...source.info,
      id: "msg_summary",
      parentID: "msg_compact",
      time: { created: 5, completed: 6 },
    },
    parts: [{ ...source.parts[0]!, id: "part_summary", messageID: "msg_summary" }],
  } as MessageWithParts;
  for (const message of [preserved, compact, summary]) {
    await store.saveMessage(message.info);
    for (const part of message.parts) await store.savePart(part);
  }
  const saved = await capsule(store, "compact-prefix");
  assert.deepEqual(saved.sourceMessageIds, ["msg_compact", "msg_preserved", "msg_summary"]);
  assert.equal((await store.commitContextCapsule(saved)).status, "committed");
  const stale = await capsule(store, "inserted-prefix");
  const inserted = user("msg_inserted", "sess_source", "turn_inserted");
  await store.saveMessage(inserted.info);
  for (const part of inserted.parts) await store.savePart(part);
  // 旧 ID Map 校验忽略新增可见条目；事务必须重建与 reader 相同的完整有序前缀。
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("update message set sequence = sequence * 2 where session_id = ?").run("sess_source");
  db.prepare(
    "update message set sequence = (select sequence - 1 from message where id = 'msg_summary') where id = 'msg_inserted'",
  ).run();
  assert.equal((await store.commitContextCapsule(stale)).status, "stale");
  assert.equal(
    await store.readContextCapsule({ sessionId: "sess_target" as SessionId, capsuleId: stale.id }),
    undefined,
  );
});

test("capsule persistence and source hashing enforce UTF-8 and structured payload budgets", async (t) => {
  const { store, source } = await setup(t),
    candidate = await capsule(store);
  assert.equal(
    ContextCapsuleSchema.safeParse({ ...candidate, content: "中".repeat(17000) }).success,
    false,
  );
  const sourceSession = (await store.getSession("sess_source" as SessionId))!;
  assert.throws(
    () =>
      contextCapsuleSourcePayload(sourceSession, [
        {
          ...source,
          parts: [{ ...source.parts[0]!, text: "中".repeat(710000) }] as MessageWithParts["parts"],
        },
      ]),
    /2 MiB/,
  );
  assert.throws(
    () =>
      contextCapsuleSourcePayload(
        sourceSession,
        Array.from({ length: 5001 }, () => source),
      ),
    /5000 messages/,
  );
});

test("synchronous capsule transaction cannot capture a concurrent ordinary write and rollback preserves it", async (t) => {
  const { store } = await setup(t),
    candidate = await capsule(store);
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec(
    "create trigger capsule_fault before update on message when new.id = 'msg_target' and json_type(new.data, '$.metadata.contextCapsuleIds') is not null begin select raise(abort, 'capsule injected fault'); end",
  );
  const ordinary = user("msg_ordinary", "sess_other", "turn_ordinary");
  const results = await Promise.allSettled([
    store.commitContextCapsule(candidate),
    store.saveMessage(ordinary.info),
  ]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "fulfilled");
  assert.equal(
    await store.readContextCapsule({
      sessionId: "sess_target" as SessionId,
      capsuleId: candidate.id,
    }),
    undefined,
  );
  assert.equal(
    (await store.messages({ sessionID: "sess_other" as SessionId }))[0]?.info.id,
    "msg_ordinary",
  );
  db.exec("drop trigger capsule_fault");
  const pair = await Promise.all([
    store.commitContextCapsule(candidate),
    store.commitContextCapsule(candidate),
  ]);
  assert.deepEqual(
    pair.map((result) => result.status),
    ["committed", "reused"],
  );
});

test("promoted input associations are atomic, idempotent and reject stale sources and target turns", async (t) => {
  const { store, source } = await setup(t);
  const saved = await capsule(store);
  await store.commitContextCapsule(saved);
  const second = await capsule(store, "second-input-context");
  await store.commitContextCapsule(second);
  const reference = { kind: "context_capsule" as const, capsule_id: saved.id };
  const next = user("msg_next", "sess_target", "turn_next");
  const intent = {
    queueItemId: "input-next",
    contextCapsuleRefs: [reference, { kind: "context_capsule" as const, capsule_id: second.id }],
  } as TurnInputIntentMetadata;
  await store.saveSessionInput({
    id: "input-next",
    sessionID: "sess_target" as SessionId,
    kind: "sendText",
    delivery: "startNow",
    payload: { text: "use saved context", intent },
  });
  await store.promoteSessionInput({
    id: "input-next",
    sessionID: "sess_target" as SessionId,
    message: next.info,
    parts: next.parts,
  });
  const input = {
    sessionId: "sess_target",
    inputId: "input-next",
    targetMessageId: "msg_next",
    targetTurnId: "turn_next",
    capsuleIds: [saved.id, second.id],
    expectedScope: saved.targetScope,
  };
  assert.equal(
    await store.attachContextCapsulesToInput({ ...input, capsuleIds: [saved.id] }),
    false,
  );
  assert.equal(
    await store.attachContextCapsulesToInput({ ...input, capsuleIds: [second.id, saved.id] }),
    false,
  );
  assert.equal(await store.attachContextCapsulesToInput(input), true);
  assert.equal(await store.attachContextCapsulesToInput(input), true);
  assert.equal(
    await store.attachContextCapsulesToInput({ ...input, targetTurnId: "stale-turn" }),
    false,
  );
  assert.equal(
    (
      await store.sessionEntries({
        sessionID: "sess_target" as SessionId,
        type: "runtime/context_capsule_input",
      })
    ).length,
    1,
  );
  await store.savePart({
    ...source.parts[0]!,
    text: "changed secret",
  } as MessageWithParts["parts"][number]);
  assert.equal(await store.attachContextCapsulesToInput(input), false);
});
