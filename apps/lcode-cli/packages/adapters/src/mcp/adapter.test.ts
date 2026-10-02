import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { createMcpAdapter } from "./index.js";

const config = { type: "stdio" as const, command: "unused-fixture-command", timeoutMs: 1_000 };

test("adapter entrypoints preserve arity and disabled connections never start a client", async (t) => {
  const connect = t.mock.method(Client.prototype, "connect", async () => {
    assert.fail("disabled server must not connect");
  });
  const adapter = createMcpAdapter();
  try {
    assert.equal(createMcpAdapter.length, 0);
    assert.equal(adapter.connectServer.length, 2);
    assert.equal(adapter.connectConfiguredServers.length, 1);
    assert.equal(adapter.callTool.length, 1);
    assert.equal(adapter.pingServer?.length, 1);
    assert.equal(
      (await adapter.connectServer("fixture", { ...config, enabled: false })).status,
      "disabled",
    );
    assert.equal(await adapter.pingServer?.("fixture"), false);
    assert.deepEqual(await adapter.listTools(), []);
    assert.equal((await adapter.disconnectServer("fixture"))?.status, "disconnected");
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    await adapter.close();
  }
  assert.deepEqual(await adapter.status(), {});
});

test("adapter reconnects after onclose and keeps request context and call options", async (t) => {
  const clients: Client[] = [];
  t.mock.method(Client.prototype, "connect", async function (this: Client) {
    clients.push(this);
  });
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: [{ name: "fixture", inputSchema: { type: "object" } }],
  }));
  t.mock.method(Client.prototype, "getProtocolEra", () => "legacy");
  t.mock.method(Client.prototype, "getNegotiatedProtocolVersion", () => undefined);
  const calls: unknown[][] = [];
  t.mock.method(Client.prototype, "callTool", async (...args: unknown[]) => {
    calls.push(args);
    return { content: [{ type: "text", text: "fixture" }], structuredContent: { result: true } };
  });
  const adapter = createMcpAdapter();
  try {
    assert.equal((await adapter.connectServer("fixture", config)).status, "connected");
    clients[0]!.onclose?.();
    assert.equal((await adapter.status()).fixture?.status, "disconnected");
    const result = await adapter.callTool({
      serverName: "fixture",
      toolName: "fixture",
      arguments: { value: 1 },
      runtimeScope: "subagent",
      workspaceIdentity: "remote:fixture",
      workspacePath: "/fixture",
      remoteSessionId: "session-fixture",
      deliveryKind: "web-remote-replayable",
    });
    assert.equal(clients.length, 2);
    assert.deepEqual(result.structuredContent, { result: true });
    const request = calls[0]![0] as { _meta: Record<string, unknown> };
    assert.equal(request._meta.workspace_identity, "remote:fixture");
    assert.equal(request._meta.remote_session_id, "session-fixture");
    assert.equal(request._meta.delivery_kind, "web-remote-replayable");
    assert.equal(request._meta.runtime_scope, "subagent");
    assert.equal(
      (calls[0]![1] as { resetTimeoutOnProgress: boolean }).resetTimeoutOnProgress,
      true,
    );
    clients[0]!.onclose?.();
    assert.equal((await adapter.status()).fixture?.status, "connected");
  } finally {
    await adapter.close();
  }
});

test("a stale connection completion cannot overwrite the replacement generation", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let connects = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    connects += 1;
    if (connects === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  t.mock.method(Client.prototype, "getProtocolEra", () => "legacy");
  t.mock.method(Client.prototype, "getNegotiatedProtocolVersion", () => undefined);
  const adapter = createMcpAdapter();
  try {
    const first = adapter.connectServer("fixture", config);
    await entered.promise;
    await adapter.connectServer("fixture", { ...config, enabled: false });
    release.resolve();
    await first;
    assert.equal((await adapter.status()).fixture?.status, "disabled");
    assert.deepEqual(await adapter.listTools(), []);
  } finally {
    release.resolve();
    await adapter.close();
  }
});
