import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserControlPort } from "@lcode/contracts";
import { browserFixture } from "./browser-control-broker.fixture.js";

function child(port: BrowserControlPort, sessionId: string, parentSessionId = "root") {
  assert.ok(port.createChildScope, "browser port must derive a live child scope");
  return port.createChildScope({ sessionId, parentSessionId });
}

const execute = (port: BrowserControlPort, sessionId: string) =>
  port.execute({
    sessionId,
    turnId: "turn-1",
    browserId: "iab-1",
    browserGeneration: 2,
    command: { method: "list" },
  });

test("child requests retain resource identity and route through the live root workspace", async () => {
  const { port, requests } = browserFixture();
  const local = child(port, "agent");
  const remote = child(port, "actor", "remote");
  const nested = child(remote, "nested", "actor");
  await Promise.all([
    local.list({ sessionId: "agent", turnId: "local-turn" }),
    nested.list({ sessionId: "nested" }),
  ]);
  assert.equal(requests[0].sessionId, "agent");
  assert.equal(requests[0].workspaceKey, "C:/workspace");
  assert.equal(requests[0].turnId, "local-turn");
  assert.equal(requests[1].sessionId, "nested");
  assert.equal(requests[1].workspaceKey, "remote-identity");
  assert.equal(requests[1].remoteSessionId, "attachment");
  assert.equal(requests[1].clientMode, "web-remote-replayable");
  // Shared MCP calls use the root broker with trusted child metadata, rather than the wrapper.
  await execute(port, "actor");
  assert.equal(requests[2].sessionId, "actor");
});

test("unknown, forged, duplicate and inactive scopes cannot route browser calls", async () => {
  const { port, sessions } = browserFixture();
  const scope = child(port, "agent");
  await assert.rejects(port.list({ sessionId: "unknown" }), /not active/);
  await assert.rejects(scope.list({ sessionId: "root" }), /scope/);
  assert.throws(() => child(port, "agent"), /already active/);
  assert.throws(() => child(scope, "forged", "remote"), /scope/);
  sessions.delete("root");
  await assert.rejects(scope.list({ sessionId: "agent" }), /not active/);
});

test("closing a child revokes only its descendants and old close cannot revoke a resumed scope", async () => {
  const { port, requests } = browserFixture();
  const first = child(port, "first");
  const second = child(port, "second");
  const nested = child(first, "nested", "first");
  await Promise.all([
    execute(first, "first"),
    execute(second, "second"),
    execute(nested, "nested"),
  ]);
  await first.closeSession?.({ sessionId: "first" });
  assert.deepEqual(
    requests
      .filter((r) => (r.command as { method: string })?.method === "closeSession")
      .map((r) => r.sessionId)
      .sort(),
    ["first", "nested"],
  );
  await assert.rejects(nested.list({ sessionId: "nested" }), /not active/);
  await second.list({ sessionId: "second" });
  const resumed = child(port, "first");
  await first.closeSession?.({ sessionId: "first" });
  await resumed.list({ sessionId: "first" });
  await port.closeSession?.({ sessionId: "root" });
  await assert.rejects(resumed.list({ sessionId: "first" }), /not active/);
});

test("closing a scope aborts in-flight requests and rejects late results", async () => {
  const { context, port, requests } = browserFixture();
  const scope = child(port, "agent");
  const originalRequest = context.requestClient;
  let complete: (() => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal: AbortSignal | undefined;
  context.requestClient = async (method, params, schema, options) => {
    if ((params as { command?: { method: string } }).command?.method === "list") {
      signal = options?.signal;
      started?.();
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    }
    return originalRequest(method, params, schema, options);
  };
  const pending = execute(scope, "agent");
  const rejected = assert.rejects(pending, /not active|abort/i);
  await ready;
  await scope.closeSession?.({ sessionId: "agent" });
  assert.equal(signal?.aborted, true);
  complete?.();
  await rejected;
  assert.ok(requests.some((r) => (r.command as { method: string })?.method === "cancelRequest"));
});

test("ended turns stay revoked across child resume while new turns remain usable", async () => {
  const { port } = browserFixture();
  const scope = child(port, "agent");
  await scope.list({ sessionId: "agent", turnId: "old-turn" });
  await scope.turnEnded?.({ sessionId: "agent", turnId: "old-turn" });
  await scope.closeSession?.({ sessionId: "agent" });
  const resumed = child(port, "agent");
  await assert.rejects(port.list({ sessionId: "agent", turnId: "old-turn" }), /turn is not active/);
  await resumed.list({ sessionId: "agent", turnId: "new-turn" });
});

test("turn cleanup aborts its own requests without closing a sibling or its next turn", async () => {
  const { context, port } = browserFixture();
  const scope = child(port, "agent");
  const original = context.requestClient;
  let release!: () => void;
  let start!: () => void;
  const ready = new Promise<void>((resolve) => {
    start = resolve;
  });
  let pendingSignal: AbortSignal | undefined;
  context.requestClient = async (method, params, schema, options) => {
    if (
      (params as { sessionId?: string }).sessionId === "agent" &&
      (params as { turnId?: string }).turnId === "old-turn" &&
      !(params as { command?: unknown }).command
    ) {
      pendingSignal = options?.signal;
      start();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(method, params, schema, options);
  };
  const pending = scope.list({ sessionId: "agent", turnId: "old-turn" });
  const rejected = assert.rejects(pending, /abort/i);
  await ready;
  await scope.turnEnded?.({ sessionId: "agent", turnId: "old-turn" });
  assert.equal(pendingSignal?.aborted, true);
  release();
  await rejected;
  await scope.list({ sessionId: "agent", turnId: "new-turn" });
  await child(port, "sibling").list({ sessionId: "sibling", turnId: "old-turn" });
});

test("root record replacement cannot revive an old scope and cleanup works after root removal", async () => {
  const { sessions, requests, port } = browserFixture();
  const scope = child(port, "agent");
  await execute(scope, "agent");
  sessions.set("root", { ...sessions.get("root")! });
  await assert.rejects(scope.list({ sessionId: "agent" }), /not active/);
  sessions.delete("root");
  await port.closeSession?.({ sessionId: "root" });
  assert.ok(
    requests.some(
      (r) =>
        r.sessionId === "agent" && (r.command as { method: string })?.method === "closeSession",
    ),
  );
});

test("parent disposal waits for an already closing descendant before releasing its reusable identity", async () => {
  const { context, port } = browserFixture();
  const parent = child(port, "parent-child");
  const nested = child(parent, "nested", "parent-child");
  await execute(nested, "nested");
  const original = context.requestClient;
  let release!: () => void;
  let start!: () => void;
  const ready = new Promise<void>((resolve) => {
    start = resolve;
  });
  context.requestClient = async (method, params, schema, options) => {
    const request = params as { sessionId: string; command?: { method: string } };
    if (request.sessionId === "nested" && request.command?.method === "closeSession") {
      start();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(method, params, schema, options);
  };
  const nestedClose = nested.closeSession!({ sessionId: "nested" });
  await ready;
  let closed = false;
  const parentClose = parent.closeSession!({ sessionId: "parent-child" }).then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => child(port, "nested"), /already active/);
  release();
  await Promise.all([nestedClose, parentClose]);
  await child(port, "nested").list({ sessionId: "nested" });
});
