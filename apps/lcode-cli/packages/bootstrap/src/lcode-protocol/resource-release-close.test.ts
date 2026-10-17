import assert from "node:assert/strict";
import test from "node:test";
import { lcodeSessionCloseResultSchema } from "@lcode/shared";
import { closeSession } from "./server-operations.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { SessionResidentPool } from "./session-resident-pool.js";

test("resource release obtains an explicit cold residency receipt without changing ordinary close", async () => {
  const context = {
    sessions: new Map(),
    assertServing: () => {},
  } as unknown as LCodeProtocolAgentServerContext;
  await assert.rejects(closeSession(context, { sessionId: "cold" }));
  const result = await closeSession(context, { sessionId: "cold", resourceRelease: true });
  assert.deepEqual(lcodeSessionCloseResultSchema.parse(result), {
    closed: true,
    residency: "absent",
  });
  context.assertServing = () => {
    throw new Error("Host incarnation is closing");
  };
  await assert.rejects(
    closeSession(context, { sessionId: "cold", resourceRelease: true }),
    /incarnation is closing/,
  );
});

test("resource close waits for the original runtime and never treats a failed close as stopped", async () => {
  let finish!: () => void;
  let deleted = false;
  const closing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const record = {
    persistence: "immediate",
    app: { close: () => closing },
    eventStore: {
      deleteSession: async () => {
        deleted = true;
      },
    },
  };
  const context = {
    sessions: new Map([["chat", record]]),
    assertServing: () => {},
  } as unknown as LCodeProtocolAgentServerContext;
  const result = closeSession(context, { sessionId: "chat", resourceRelease: true });
  await Promise.resolve();
  assert.equal(deleted, false);
  assert.equal(context.sessions.has("chat"), true);
  finish();
  assert.deepEqual(await result, { closed: true, residency: "closed" });
  assert.equal(deleted, true);
  assert.equal(context.sessions.has("chat"), false);
  record.app.close = () => Promise.reject(new Error("Writer did not stop"));
  context.sessions.set("busy", record as never);
  await assert.rejects(
    closeSession(context, { sessionId: "busy", resourceRelease: true }),
    /Writer did not stop/,
  );
  assert.equal(context.sessions.has("busy"), true);
});

test("resource absence receipts refuse in-flight creation and retain the existing residency gate", async () => {
  const pool = new SessionResidentPool({
    listSessionIds: () => [],
    readResidencyFacts: () => null,
    deactivate: () => ({ status: "blocked" }),
  });
  const context = {
    sessions: new Map(),
    sessionResidentPool: pool,
  } as unknown as LCodeProtocolAgentServerContext;
  const creation = await pool.acquireOperation();
  await assert.rejects(
    closeSession(context, { sessionId: "future-child", resourceRelease: true }),
    /Another Agent operation/,
  );
  const ownRequest = await pool.acquireOperation("future-child");
  await assert.rejects(
    closeSession(context, { sessionId: "future-child", resourceRelease: true }, true),
    /Another Agent operation/,
  );
  creation();
  assert.deepEqual(
    await closeSession(context, { sessionId: "future-child", resourceRelease: true }, true),
    { closed: true, residency: "absent" },
  );
  ownRequest();
});
