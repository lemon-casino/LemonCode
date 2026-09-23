// PiP 会话客户端单测：进程内 net 服务器扮演认证、快照恢复和 ACK 对端。
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPipSessionClient } from "./pip-session-node.js";

const PROTOCOL = "zcode.cua/pip-session";
const CAPABILITY = "test-pip-capability";
const GENERATION = 7;

function pipeName() {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zcode-cua-pip-test-${suffix}`
    : path.join(os.tmpdir(), `zcode-cua-pip-test-${suffix}`);
}

function listen(server) {
  const name = pipeName();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, () => resolve(name));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// 协议对端：可注入逐帧行为，默认严格检查认证握手并 ACK 事件。
function startServer({
  handshake = "ok",
  handshakeDelayMs = 0,
  ack = { applied: true },
  onFrame,
} = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const connectionIndex = ++server.connectionCount;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        server.frames.push({ connectionIndex, frame });
        if (onFrame?.({ connectionIndex, frame, socket, server }) === true) continue;
        if (frame.protocol === PROTOCOL) {
          assert.equal(frame.role, "presentation");
          assert.equal(frame.capability, CAPABILITY);
          assert.equal(frame.generation, GENERATION);
          const ok = handshake === "ok";
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.write(
                `${JSON.stringify(
                  ok
                    ? { id: frame.id, ok: true, version: 1 }
                    : {
                        id: frame.id,
                        ok: false,
                        code: "version_mismatch",
                        error: "unsupported",
                      },
                )}\n`,
              );
            }
          }, handshakeDelayMs);
        } else if (frame.kind === "event") {
          socket.write(`${JSON.stringify({ id: frame.id, ok: true, ...ack })}\n`);
        }
      }
    });
    socket.once("close", () => sockets.delete(socket));
  });
  server.frames = [];
  server.connectionCount = 0;
  return {
    server,
    listen: () => listen(server),
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

function clientOptions(socketPath, overrides = {}) {
  return {
    socketPath,
    capability: CAPABILITY,
    generation: GENERATION,
    ...overrides,
  };
}

test("认证握手携带快照，成功后事件被 ACK", async (t) => {
  const endpoint = startServer();
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const snapshot = {
    turns: [
      {
        kind: "turn-started",
        sessionId: "s1",
        turnId: "t1",
        sequenceNumber: 4,
      },
    ],
  };
  const client = createPipSessionClient(clientOptions(name, { getSnapshot: () => snapshot }));
  t.after(() => client.close());
  assert.ok(client.enabled);
  await client.connect();
  const event = { kind: "turn-started", sessionId: "s1", turnId: "t1" };
  assert.deepEqual(await client.send(event), { applied: true });
  assert.equal(endpoint.server.frames[0].frame.protocol, PROTOCOL);
  assert.deepEqual(endpoint.server.frames[0].frame.snapshot, snapshot);
  assert.equal(endpoint.server.frames[1].frame.kind, "event");
  assert.deepEqual(endpoint.server.frames[1].frame.event, event);
});

test("ACK applied:false 时透传 reason（协调器幂等拒绝）", async (t) => {
  const endpoint = startServer({ ack: { applied: false, reason: "stale-sequence" } });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(clientOptions(name));
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(
    await client.send({
      kind: "turn-ended",
      sessionId: "s1",
      turnId: "t1",
      outcome: "completed",
    }),
    { applied: false, reason: "stale-sequence" },
  );
});

test("并发 connect/send 必须等握手 ACK 后才发送事件", async (t) => {
  const endpoint = startServer({ handshakeDelayMs: 40 });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(clientOptions(name));
  t.after(() => client.close());
  await Promise.all([
    client.connect(),
    client.send({ kind: "turn-started", sessionId: "s", turnId: "t" }),
  ]);
  assert.deepEqual(
    endpoint.server.frames.map(({ frame }) => (frame.protocol ? "handshake" : frame.kind)),
    ["handshake", "event"],
  );
});

test("断线重连会重新获取并发送最新快照，然后重试事件", async (t) => {
  let snapshotRevision = 0;
  const endpoint = startServer({
    onFrame({ connectionIndex, frame, socket }) {
      if (frame.kind === "event" && connectionIndex === 1) {
        socket.destroy();
        return true;
      }
      return false;
    },
  });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(
    clientOptions(name, {
      reconnectAttempts: 1,
      reconnectDelayMs: 1,
      getSnapshot: () => ({
        turns: [
          {
            kind: "turn-started",
            sessionId: "s",
            turnId: "t",
            sequenceNumber: ++snapshotRevision,
          },
        ],
      }),
    }),
  );
  t.after(() => client.close());
  assert.deepEqual(await client.send({ kind: "turn-started", sessionId: "s", turnId: "t" }), {
    applied: true,
  });
  const handshakes = endpoint.server.frames.filter(({ frame }) => frame.protocol === PROTOCOL);
  assert.equal(handshakes.length, 2);
  assert.equal(handshakes[0].frame.snapshot.turns[0].sequenceNumber, 1);
  assert.equal(handshakes[1].frame.snapshot.turns[0].sequenceNumber, 2);
});

test("版本不匹配：connect 失败且不被重试掩盖", async (t) => {
  const endpoint = startServer({ handshake: "mismatch" });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const diagnostics = [];
  const client = createPipSessionClient(
    clientOptions(name, {
      reconnectAttempts: 0,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    }),
  );
  t.after(() => client.close());
  await assert.rejects(
    () => client.connect(),
    (error) => error.code === "version_mismatch",
  );
  await assert.rejects(
    () => client.send({ kind: "turn-started", sessionId: "s", turnId: "t" }),
    (error) => error.code === "version_mismatch",
  );
  assert.ok(diagnostics.includes("version_mismatch"));
});

test("握手成功 ACK 含多余字段时按坏帧关闭连接", async (t) => {
  const endpoint = startServer({
    onFrame({ frame, socket }) {
      if (frame.protocol !== PROTOCOL) return false;
      socket.write(`${JSON.stringify({ id: frame.id, ok: true, version: 1, extra: true })}\n`);
      return true;
    },
  });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(clientOptions(name, { reconnectAttempts: 0 }));
  t.after(() => client.close());

  await assert.rejects(
    () => client.connect(),
    (error) => error.code === "bad_frame",
  );
});

test("事件成功 ACK 的 applied 类型错误时按坏帧关闭连接", async (t) => {
  const endpoint = startServer({
    onFrame({ frame, socket }) {
      if (frame.kind !== "event") return false;
      socket.write(`${JSON.stringify({ id: frame.id, ok: true, applied: "yes" })}\n`);
      return true;
    },
  });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(clientOptions(name, { reconnectAttempts: 0 }));
  t.after(() => client.close());
  await client.connect();

  await assert.rejects(
    () => client.send({ kind: "turn-started", sessionId: "s", turnId: "t" }),
    (error) => error.code === "bad_frame",
  );
});

test("失败 ACK 含多余字段时不能伪装成已知服务端拒绝", async (t) => {
  const endpoint = startServer({
    onFrame({ frame, socket }) {
      if (frame.kind !== "event") return false;
      socket.write(
        `${JSON.stringify({
          id: frame.id,
          ok: false,
          code: "not_authorized",
          error: "denied",
          extra: true,
        })}\n`,
      );
      return true;
    },
  });
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(clientOptions(name, { reconnectAttempts: 0 }));
  t.after(() => client.close());
  await client.connect();

  await assert.rejects(
    () => client.send({ kind: "turn-started", sessionId: "s", turnId: "t" }),
    (error) => error.code === "bad_frame",
  );
});

test("peer 拒绝：握手字节发出前断开，服务端收不到任何帧", async (t) => {
  const endpoint = startServer();
  const name = await endpoint.listen();
  t.after(() => endpoint.close());
  const client = createPipSessionClient(
    clientOptions(name, { reconnectAttempts: 0, peerChecker: () => false }),
  );
  t.after(() => client.close());
  await assert.rejects(
    () => client.connect(),
    (error) => error.code === "peer_rejected",
  );
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(endpoint.server.frames.length, 0);
});

test("无认证凭据禁用；close 后 send 拒绝且不再重连", async () => {
  const missingCredentials = createPipSessionClient({ socketPath: pipeName() });
  assert.equal(missingCredentials.enabled, false);
  await assert.rejects(
    () => missingCredentials.connect(),
    (error) => error.code === "not_authorized",
  );

  const client = createPipSessionClient(clientOptions(pipeName(), { reconnectAttempts: 0 }));
  client.close();
  client.close();
  await assert.rejects(
    () => client.send({ kind: "turn-started", sessionId: "s", turnId: "t" }),
    (error) => error.code === "closed",
  );
});
