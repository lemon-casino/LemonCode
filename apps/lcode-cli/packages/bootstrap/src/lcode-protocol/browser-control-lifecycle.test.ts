import assert from "node:assert/strict";
import test from "node:test";
import { lcodeProtocolMethods, type LCodeProtocolRequest } from "@lcode/shared";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { browserFixture } from "./browser-control-broker.fixture.js";
import {
  requestClient,
  resolveClientRequest,
  type ProtocolClientRequestState,
} from "./server-client-requests.js";

function lifecycleFixture() {
  const { context, sessions } = browserFixture();
  const requests: LCodeProtocolRequest[] = [];
  const host: ProtocolClientRequestState = {
    nextClientRequestId: 1,
    pendingClientRequests: new Map(),
    messageSink(message) {
      if (!("id" in message)) return;
      requests.push(message);
      const command = (message.params as { command?: { method: string } }).command;
      if (command?.method === "list" || command?.method === "cancelRequest")
        resolveClientRequest(host, message.id, { ok: true, elapsedMs: 0 });
      if (message.method === lcodeProtocolMethods.interactionBrowserList)
        resolveClientRequest(host, message.id, { browsers: [] });
    },
  };
  context.requestClient = (method, params, schema, options) =>
    requestClient(host, method, params, schema, { ...options, timeoutMs: options?.timeoutMs ?? 1 });
  const port = createProtocolBrowserControlBroker(context, { ackTimeoutMs: 1 });
  const scope = port.createChildScope!({ parentSessionId: "root", sessionId: "actor" });
  const execute = (turnId = "old", generation = 2) =>
    scope.execute({
      sessionId: "actor",
      turnId,
      browserId: "iab-1",
      browserGeneration: generation,
      command: { method: "list" },
    });
  const acknowledge = () => {
    for (const request of requests)
      resolveClientRequest(host, request.id, { ok: true, elapsedMs: 0 });
  };
  return { context, sessions, requests, host, port, scope, execute, acknowledge };
}

test("unconfirmed close revokes execution, retains its ID, and retires only after the original late ACK", async () => {
  const f = lifecycleFixture();
  await f.execute();
  const result = await f.scope.closeSession!({ sessionId: "actor" });
  assert.equal(result?.phase, "cleanup_pending");
  await assert.rejects(f.scope.list({ sessionId: "actor" }), /not active/);
  assert.throws(
    () => f.port.createChildScope!({ parentSessionId: "root", sessionId: "actor" }),
    (error: unknown) => (error as { reason: string }).reason === "cleanup_pending",
  );
  await f.scope.closeSession!({ sessionId: "actor" });
  assert.equal(
    f.requests.filter(
      (r) => (r.params as { command?: { method: string } }).command?.method === "closeSession",
    ).length,
    1,
    "unknown cleanup is never resent",
  );
  f.acknowledge();
  const resumed = f.port.createChildScope!({ parentSessionId: "root", sessionId: "actor" });
  await f.scope.closeSession!({ sessionId: "actor" });
  await resumed.list({ sessionId: "actor" });
  await resumed.closeSession!({ sessionId: "actor" });
  assert.equal(f.host.pendingClientRequests.size, 0);
});

test("turn cleanup waits finitely and gates only the pending backend until ACK", async () => {
  const f = lifecycleFixture();
  await f.execute();
  const result = await f.scope.turnEnded!({ sessionId: "actor", turnId: "old" });
  assert.equal(result?.phase, "cleanup_pending");
  await f.scope.list({ sessionId: "actor", turnId: "new" });
  await assert.rejects(
    f.execute("new"),
    (error: unknown) => (error as { reason: string }).reason === "turn_cleanup_pending",
  );
  await f.execute("new", 3);
  f.acknowledge();
  await f.execute("new");
  const closing = f.scope.closeSession!({ sessionId: "actor" });
  await Promise.resolve();
  f.acknowledge();
  await closing;
});

test("cleanup uses the original connection route after mutable root metadata changes", async () => {
  const { context, port, requests, sessions } = browserFixture();
  const scope = port.createChildScope!({ parentSessionId: "remote", sessionId: "actor" });
  await scope.execute({
    sessionId: "actor",
    browserId: "iab-1",
    browserGeneration: 2,
    command: { method: "list" },
  });
  sessions.get("remote")!.workspace = {
    workspacePath: "changed",
    workspaceKey: "new-identity",
    workspaceIdentity: "new-identity",
    remoteSessionId: "new-attachment",
  };
  await scope.closeSession!({ sessionId: "actor" });
  const cleanup = requests.find(
    (r) => (r.command as { method: string })?.method === "closeSession",
  )!;
  assert.equal(cleanup.workspaceKey, "remote-identity");
  assert.equal(cleanup.remoteSessionId, "attachment");
  assert.equal(cleanup.browserGeneration, 2);
});
