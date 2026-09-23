import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";

import { createPipSessionCoordinator } from "./pip-session-coordinator.js";
import {
  PIP_SESSION_PROTOCOL_ID,
  PIP_SESSION_PROTOCOL_VERSION,
  createPipSessionServer,
} from "./pip-session-server.js";

const capability = "test-capability";
const generation = 7;

function pipeName() {
  return `\\\\.\\pipe\\zcode-cua-pip-test-${randomUUID()}`;
}

function presenter() {
  return { async show() {}, async hide() {}, async dispose() {} };
}

function connectLines(socketPath) {
  const socket = createConnection(socketPath);
  let buffer = "";
  const frames = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  return {
    socket,
    async ready() {
      if (!socket.connecting) return;
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    },
    next() {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function handshake(overrides = {}) {
  return {
    id: "handshake",
    protocol: PIP_SESSION_PROTOCOL_ID,
    version: PIP_SESSION_PROTOCOL_VERSION,
    role: "presentation",
    capability,
    generation,
    snapshot: { turns: [] },
    ...overrides,
  };
}

test("server authenticates a fragmented handshake and processes multiple event frames", async (t) => {
  const coordinator = createPipSessionCoordinator({ presenter: presenter() });
  const server = await createPipSessionServer({
    socketPath: pipeName(),
    capability,
    generation,
    coordinator,
    platform: "win32",
  });
  t.after(() => server.close());
  const client = connectLines(server.socketPath);
  t.after(() => client.socket.destroy());
  await client.ready();
  const encoded = `${JSON.stringify(handshake())}\n`;
  client.socket.write(encoded.slice(0, 13));
  client.socket.write(encoded.slice(13));
  assert.deepEqual(await client.next(), { id: "handshake", ok: true, version: 1 });

  const first = {
    id: "one",
    kind: "event",
    event: {
      kind: "turn-started",
      sessionId: "session-a",
      turnId: "turn-a",
      sequenceNumber: 1,
    },
  };
  const second = {
    id: "two",
    kind: "event",
    event: {
      kind: "focus-changed",
      sessionId: "session-a",
      revision: 1,
      sourceWindowId: "window-1",
    },
  };
  client.socket.write(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  assert.deepEqual(await client.next(), { id: "one", ok: true, applied: true });
  assert.deepEqual(await client.next(), { id: "two", ok: true, applied: true });
});

test("wrong capability is rejected before the coordinator sees a snapshot", async (t) => {
  let snapshotCalls = 0;
  const server = await createPipSessionServer({
    socketPath: pipeName(),
    capability,
    generation,
    platform: "win32",
    coordinator: {
      async applySnapshot() {
        snapshotCalls += 1;
      },
      async applyEvent() {
        return { applied: true };
      },
      async dispose() {},
    },
  });
  t.after(() => server.close());
  const client = connectLines(server.socketPath);
  await client.ready();
  client.socket.write(
    `${JSON.stringify(handshake({ capability: "wrong" }))}\n${JSON.stringify(
      handshake({ id: "second", capability }),
    )}\n`,
  );
  assert.deepEqual(await client.next(), {
    id: "handshake",
    ok: false,
    code: "not_authorized",
    error: "PiP presentation client is not authorized",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(snapshotCalls, 0);
});

test("a new authenticated writer atomically replaces the old connection", async (t) => {
  const server = await createPipSessionServer({
    socketPath: pipeName(),
    capability,
    generation,
    platform: "win32",
    coordinator: createPipSessionCoordinator({ presenter: presenter() }),
  });
  t.after(() => server.close());
  const first = connectLines(server.socketPath);
  await first.ready();
  first.socket.write(`${JSON.stringify(handshake({ id: "first" }))}\n`);
  assert.equal((await first.next()).ok, true);
  const firstClosed = new Promise((resolve) => first.socket.once("close", resolve));

  const second = connectLines(server.socketPath);
  await second.ready();
  second.socket.write(`${JSON.stringify(handshake({ id: "second" }))}\n`);
  assert.equal((await second.next()).ok, true);
  await firstClosed;
});

test("presenter-unavailable server fails the handshake without applying state", async (t) => {
  const server = await createPipSessionServer({
    socketPath: pipeName(),
    capability,
    generation,
    platform: "win32",
    coordinator: null,
    available: false,
  });
  t.after(() => server.close());
  const client = connectLines(server.socketPath);
  await client.ready();
  client.socket.write(`${JSON.stringify(handshake())}\n`);
  assert.equal((await client.next()).code, "server_unavailable");
});
