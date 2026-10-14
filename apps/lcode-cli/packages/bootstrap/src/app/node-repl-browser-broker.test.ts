import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net, { createConnection } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { BrowserControlPort, Logger } from "@lcode/contracts";
import { createNodeReplBrowserBroker } from "./node-repl-browser-broker.js";

const logger = { debug() {}, warn() {}, error() {} } as unknown as Logger;

test("closing the broker aborts accepted requests and closes their sockets", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const port: BrowserControlPort = {
    list: async (input) => {
      signal = input.signal;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    },
    execute: async () => ({ ok: true, elapsedMs: 0 }),
  };
  const broker = createNodeReplBrowserBroker({ browserControlPort: port, logger });
  await broker.ready;
  const socket = createConnection(broker.socketPath);
  t.after(async () => {
    socket.destroy();
    release?.();
    await broker.close();
  });
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    socket.write(
      JSON.stringify({
        id: randomUUID(),
        token: broker.token,
        runtimeScope: "subagent",
        sessionId: "actor",
        op: "list",
      }) + "\n",
    );
    await ready;
    const closed = once(socket, "close");
    const closing = broker.close();
    await Promise.resolve();
    assert.equal(signal?.aborted, true);
    await closing;
    await closed;
    release();
    await broker.close();
  } finally {
    socket.destroy();
    release?.();
    await broker.close();
  }
});

test(
  "close also destroys an accepted socket with an incomplete request line",
  { timeout: 1_000 },
  async (t) => {
    let accepted!: () => void;
    const connected = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const original = net.createServer;
    const mock = t.mock.method(
      net,
      "createServer",
      (...args: Parameters<typeof net.createServer>) => {
        const server = original(...args);
        server.once("connection", accepted);
        return server;
      },
    );
    syncBuiltinESMExports();
    const broker = createNodeReplBrowserBroker({
      browserControlPort: {
        list: async () => [],
        execute: async () => ({ ok: true, elapsedMs: 0 }),
      },
      logger,
    });
    await broker.ready;
    const socket = createConnection(broker.socketPath);
    t.after(async () => {
      socket.destroy();
      await broker.close();
      mock.mock.restore();
      syncBuiltinESMExports();
    });
    socket.on("error", () => {});
    try {
      await once(socket, "connect");
      await connected;
      socket.write("{");
      const closed = once(socket, "close");
      await broker.close();
      await closed;
    } finally {
      socket.destroy();
      await broker.close();
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
