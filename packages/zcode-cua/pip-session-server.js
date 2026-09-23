import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { TextDecoder } from "node:util";

import {
  normalizePipSessionEvent,
  normalizePipSessionSnapshot,
} from "./pip-session-coordinator.js";

export const PIP_SESSION_PROTOCOL_ID = "zcode.cua/pip-session";
export const PIP_SESSION_PROTOCOL_VERSION = 1;
export const MAX_PIP_SESSION_FRAME_BYTES = 1024 * 1024;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_REQUEST_ID_LENGTH = 255;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function requestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH
    ? value
    : undefined;
}

function equalCapability(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function response(id, fields) {
  return `${JSON.stringify({ id, ...fields })}\n`;
}

function failure(id, code, error) {
  return response(id, { ok: false, code, error });
}

async function removeSocket(socketPath, platform) {
  if (platform !== "win32") await rm(socketPath, { force: true });
}

export async function createPipSessionServer(options = {}) {
  const socketPath = typeof options.socketPath === "string" ? options.socketPath.trim() : "";
  const capability = typeof options.capability === "string" ? options.capability : "";
  const generation = options.generation;
  const coordinator = options.coordinator;
  const platform = options.platform ?? process.platform;
  if (!socketPath) throw new TypeError("PiP socket path is required");
  if (!capability) throw new TypeError("PiP capability is required");
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("PiP generation must be a non-negative safe integer");
  }
  if (
    coordinator &&
    (typeof coordinator.applySnapshot !== "function" ||
      typeof coordinator.applyEvent !== "function" ||
      typeof coordinator.dispose !== "function")
  ) {
    throw new TypeError("PiP coordinator is invalid");
  }

  await removeSocket(socketPath, platform);
  const sockets = new Set();
  let activeWriter;
  let writerEpoch = 0;
  let closed = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const connection = {
      buffer: Buffer.alloc(0),
      closed: false,
      ready: false,
      epoch: 0,
      tail: Promise.resolve(),
    };

    const closeConnection = () => {
      if (connection.closed) return;
      connection.closed = true;
      if (activeWriter === socket) activeWriter = undefined;
      socket.destroy();
    };

    const writeFailureAndClose = (id, code, message) => {
      if (connection.closed) return;
      connection.closed = true;
      if (activeWriter === socket) activeWriter = undefined;
      if (socket.writable) socket.end(failure(id ?? null, code, message));
      else socket.destroy();
    };

    const handleHandshake = async (frame, id) => {
      if (
        !exactKeys(
          frame,
          new Set(["id", "protocol", "version", "role", "capability", "generation", "snapshot"]),
        )
      ) {
        writeFailureAndClose(id, "invalid_request", "PiP handshake is invalid");
        return;
      }
      if (frame.protocol !== PIP_SESSION_PROTOCOL_ID) {
        writeFailureAndClose(id, "invalid_request", "PiP protocol identifier is invalid");
        return;
      }
      if (frame.version !== PIP_SESSION_PROTOCOL_VERSION) {
        writeFailureAndClose(id, "version_mismatch", "PiP protocol version is not supported");
        return;
      }
      if (
        frame.role !== "presentation" ||
        frame.generation !== generation ||
        !equalCapability(frame.capability, capability)
      ) {
        writeFailureAndClose(id, "not_authorized", "PiP presentation client is not authorized");
        return;
      }
      const snapshot = normalizePipSessionSnapshot(frame.snapshot);
      if (!snapshot) {
        writeFailureAndClose(id, "invalid_request", "PiP snapshot is invalid");
        return;
      }
      if (!coordinator || options.available === false) {
        writeFailureAndClose(id, "server_unavailable", "PiP presentation is unavailable");
        return;
      }

      const previous = activeWriter;
      connection.epoch = ++writerEpoch;
      activeWriter = socket;
      if (previous && previous !== socket) previous.destroy();
      try {
        await coordinator.applySnapshot(snapshot);
      } catch {
        if (activeWriter === socket) activeWriter = undefined;
        writeFailureAndClose(
          id,
          "server_unavailable",
          "PiP presentation state could not be restored",
        );
        return;
      }
      if (closed || activeWriter !== socket || connection.epoch !== writerEpoch) {
        writeFailureAndClose(id, "writer_replaced", "PiP presentation writer was replaced");
        return;
      }
      connection.ready = true;
      options.onActivity?.();
      socket.write(response(id, { ok: true, version: PIP_SESSION_PROTOCOL_VERSION }));
    };

    const handleEvent = async (frame, id) => {
      if (!connection.ready || activeWriter !== socket || connection.epoch !== writerEpoch) {
        writeFailureAndClose(id, "writer_replaced", "PiP presentation writer is not active");
        return;
      }
      if (!exactKeys(frame, new Set(["id", "kind", "event"])) || frame.kind !== "event") {
        socket.write(failure(id, "invalid_request", "PiP event frame is invalid"));
        return;
      }
      const event = normalizePipSessionEvent(frame.event);
      if (!event) {
        socket.write(failure(id, "invalid_request", "PiP event is invalid"));
        return;
      }
      try {
        const result = await coordinator.applyEvent(event);
        if (closed || activeWriter !== socket || connection.epoch !== writerEpoch) return;
        options.onActivity?.();
        socket.write(
          response(id, {
            ok: true,
            applied: result.applied === true,
            ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
          }),
        );
      } catch {
        socket.write(
          failure(id, "server_unavailable", "PiP presentation event could not be applied"),
        );
      }
    };

    const handleLine = async (bytes) => {
      if (connection.closed || closed) return;
      let line;
      try {
        line = utf8Decoder.decode(bytes);
      } catch {
        writeFailureAndClose(null, "invalid_request", "PiP frame is not valid UTF-8");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        writeFailureAndClose(null, "invalid_request", "PiP frame is not valid JSON");
        return;
      }
      const id = isRecord(frame) ? requestId(frame.id) : undefined;
      if (!isRecord(frame) || !id) {
        writeFailureAndClose(null, "invalid_request", "PiP frame has an invalid request id");
        return;
      }
      if (!connection.ready) await handleHandshake(frame, id);
      else if (Object.hasOwn(frame, "protocol")) {
        writeFailureAndClose(id, "invalid_request", "PiP connection is already authenticated");
      } else {
        await handleEvent(frame, id);
      }
    };

    socket.on("data", (chunk) => {
      if (connection.closed || closed) return;
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      for (;;) {
        const newline = connection.buffer.indexOf(0x0a);
        if (newline < 0) {
          if (connection.buffer.length > MAX_PIP_SESSION_FRAME_BYTES) {
            writeFailureAndClose(null, "request_too_large", "PiP frame exceeded the 1 MiB limit");
          }
          return;
        }
        if (newline > MAX_PIP_SESSION_FRAME_BYTES) {
          writeFailureAndClose(null, "request_too_large", "PiP frame exceeded the 1 MiB limit");
          return;
        }
        const line = connection.buffer.subarray(0, newline);
        connection.buffer = connection.buffer.subarray(newline + 1);
        if (line.length === 0) continue;
        connection.tail = connection.tail.then(() => handleLine(line));
      }
    });
    socket.once("error", closeConnection);
    socket.once("close", () => {
      connection.closed = true;
      sockets.delete(socket);
      if (activeWriter === socket) activeWriter = undefined;
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(socketPath);
  await ready;
  if (platform !== "win32") await chmod(socketPath, 0o600);

  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      try {
        await coordinator?.dispose();
      } finally {
        for (const socket of sockets) socket.destroy();
        await serverClosed;
        await removeSocket(socketPath, platform);
      }
    },
  };
}
