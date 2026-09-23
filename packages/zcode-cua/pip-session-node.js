import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { TextDecoder } from "node:util";

import {
  normalizePipSessionEvent,
  normalizePipSessionSnapshot,
} from "./pip-session-coordinator.js";

const PIP_SESSION_PROTOCOL_ID = "zcode.cua/pip-session";
const PIP_SESSION_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_ATTEMPTS = 2;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_FRAME_BYTES = 1024 * 1024;
const NON_RETRYABLE_CODES = new Set([
  "version_mismatch",
  "not_authorized",
  "peer_rejected",
  "server_unavailable",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = new Set()) {
  const keys = Object.keys(value);
  if (keys.length < required.size || keys.length > required.size + optional.size) return false;
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return keys.every((key) => required.has(key) || optional.has(key));
}

function isExpectedResponse(frame, responseKind) {
  if (!isRecord(frame)) return false;
  if (frame.ok === false) {
    return (
      hasExactKeys(frame, new Set(["id", "ok", "code", "error"])) &&
      typeof frame.code === "string" &&
      frame.code.length > 0 &&
      typeof frame.error === "string" &&
      frame.error.length > 0
    );
  }
  if (frame.ok !== true) return false;
  if (responseKind === "handshake") {
    return (
      hasExactKeys(frame, new Set(["id", "ok", "version"])) &&
      Number.isSafeInteger(frame.version) &&
      frame.version >= 0
    );
  }
  return (
    hasExactKeys(frame, new Set(["id", "ok", "applied"]), new Set(["reason"])) &&
    typeof frame.applied === "boolean" &&
    (frame.reason === undefined || typeof frame.reason === "string")
  );
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function createPipSessionClient(options = {}) {
  const socketPath = typeof options.socketPath === "string" ? options.socketPath.trim() : "";
  const capability = typeof options.capability === "string" ? options.capability.trim() : "";
  const generation = options.generation;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const reconnectAttempts = nonNegativeInteger(
    options.reconnectAttempts,
    DEFAULT_RECONNECT_ATTEMPTS,
  );
  const reconnectDelayMs = positiveNumber(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
  const onDiagnostic =
    typeof options.onDiagnostic === "function" ? options.onDiagnostic : undefined;
  const peerChecker = typeof options.peerChecker === "function" ? options.peerChecker : undefined;
  const getSnapshot =
    typeof options.getSnapshot === "function" ? options.getSnapshot : () => ({ turns: [] });

  const state = {
    closed: false,
    readySocket: undefined,
    connecting: undefined,
    sockets: new Set(),
    pending: new Map(),
  };

  const diagnostic = (code, message) => {
    try {
      onDiagnostic?.({ code, message });
    } catch {
      // 诊断回调不能改变连接状态。
    }
  };

  function failPendingForSocket(socket, error) {
    for (const [id, entry] of state.pending) {
      if (entry.socket !== socket) continue;
      state.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function terminate(socket, error) {
    if (state.readySocket === socket) state.readySocket = undefined;
    state.sockets.delete(socket);
    failPendingForSocket(socket, error);
    if (!socket.destroyed) socket.destroy();
  }

  function handleFrame(socket, line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      diagnostic("bad_frame", "pip-session channel received a non-JSON frame");
      terminate(socket, codedError("pip-session channel received an invalid frame", "bad_frame"));
      return;
    }
    const entry = typeof frame?.id === "string" ? state.pending.get(frame.id) : undefined;
    if (!entry || entry.socket !== socket) {
      diagnostic("unexpected_frame", "pip-session channel received a frame with unknown id");
      terminate(
        socket,
        codedError("pip-session channel received an unexpected frame", "bad_frame"),
      );
      return;
    }
    // 根因：只按 id/ok 结算会把错版或伪造 ACK 静默降级成 applied:false；必须先按
    // 对应请求种类校验完整帧，再允许任何 pending promise 成功或按服务端错误失败。
    if (!isExpectedResponse(frame, entry.responseKind)) {
      const error = codedError(
        "pip-session channel received an invalid acknowledgement",
        "bad_frame",
      );
      diagnostic(error.code, error.message);
      terminate(socket, error);
      return;
    }
    state.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok !== true) {
      const message =
        typeof frame.error === "string" && frame.error ? frame.error : "pip-session request failed";
      const code = typeof frame.code === "string" && frame.code ? frame.code : "request_failed";
      diagnostic(code, message);
      entry.reject(codedError(message, code));
      return;
    }
    entry.resolve(frame);
  }

  function attach(socket) {
    let buffer = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > MAX_FRAME_BYTES) {
            const error = codedError(
              "pip-session channel frame exceeded the 1 MiB limit",
              "bad_frame",
            );
            diagnostic(error.code, error.message);
            terminate(socket, error);
          }
          return;
        }
        if (newline > MAX_FRAME_BYTES) {
          const error = codedError(
            "pip-session channel frame exceeded the 1 MiB limit",
            "bad_frame",
          );
          diagnostic(error.code, error.message);
          terminate(socket, error);
          return;
        }
        const bytes = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (bytes.length === 0) continue;
        let line;
        try {
          line = decoder.decode(bytes);
        } catch {
          const error = codedError("pip-session channel frame is not valid UTF-8", "bad_frame");
          diagnostic(error.code, error.message);
          terminate(socket, error);
          return;
        }
        handleFrame(socket, line);
      }
    });
    socket.once("error", (error) => terminate(socket, error));
    socket.once("close", () => {
      terminate(socket, codedError("pip-session channel closed", "connection_closed"));
    });
  }

  function request(socket, fields, responseKind, timeout = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(codedError("pip-session channel is not connected", "connection_closed"));
        return;
      }
      const id = randomUUID();
      const entry = {
        socket,
        responseKind,
        timer: setTimeout(() => {
          state.pending.delete(id);
          const error = codedError("pip-session request timed out", "timeout");
          reject(error);
          terminate(socket, error);
        }, timeout),
        resolve,
        reject,
      };
      state.pending.set(id, entry);
      try {
        socket.write(`${JSON.stringify({ id, ...fields })}\n`);
      } catch (error) {
        state.pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
        terminate(socket, error);
      }
    });
  }

  async function connectOnce() {
    const socket = createConnection(socketPath);
    state.sockets.add(socket);
    attach(socket);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(codedError("pip-session connection timed out", "timeout")),
          timeoutMs,
        );
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      if (state.closed) throw codedError("pip-session client is closed", "closed");
      if (peerChecker) {
        const peer = { remoteAddress: socket.remoteAddress ?? undefined };
        if (!peerChecker(peer)) {
          diagnostic("peer_rejected", `pip-session peer rejected: ${String(peer.remoteAddress)}`);
          throw codedError("pip-session peer rejected", "peer_rejected");
        }
      }
      const snapshot = normalizePipSessionSnapshot(await getSnapshot());
      if (!snapshot) throw codedError("pip-session snapshot is invalid", "invalid_request");
      const handshake = await request(
        socket,
        {
          protocol: PIP_SESSION_PROTOCOL_ID,
          version: PIP_SESSION_PROTOCOL_VERSION,
          role: "presentation",
          capability,
          generation,
          snapshot,
        },
        "handshake",
      );
      if (handshake.version !== PIP_SESSION_PROTOCOL_VERSION) {
        throw codedError("pip-session peer returned an invalid version", "version_mismatch");
      }
      if (state.closed || socket.destroyed)
        throw codedError("pip-session client is closed", "closed");
      state.readySocket = socket;
    } catch (error) {
      terminate(socket, error);
      throw error;
    }
  }

  async function ensureConnected() {
    if (state.closed) throw codedError("pip-session client is closed", "closed");
    if (state.readySocket && !state.readySocket.destroyed) return state.readySocket;
    if (state.connecting) {
      await state.connecting;
      if (!state.readySocket)
        throw codedError("pip-session connection failed", "connection_closed");
      return state.readySocket;
    }
    const connecting = connectOnce();
    state.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (state.connecting === connecting) state.connecting = undefined;
    }
    if (!state.readySocket) throw codedError("pip-session connection failed", "connection_closed");
    return state.readySocket;
  }

  const credentialsValid =
    socketPath.length > 0 &&
    capability.length > 0 &&
    Number.isSafeInteger(generation) &&
    generation >= 0;

  return {
    enabled: credentialsValid,

    async connect() {
      if (!credentialsValid)
        throw codedError("pip-session client has no valid credentials", "not_authorized");
      await ensureConnected();
    },

    async send(eventInput) {
      if (!credentialsValid)
        throw codedError("pip-session client has no valid credentials", "not_authorized");
      const event = normalizePipSessionEvent(eventInput);
      if (!event) throw codedError("pip-session event is invalid", "invalid_request");
      let lastError;
      for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
        try {
          const socket = await ensureConnected();
          const response = await request(socket, { kind: "event", event }, "event");
          return {
            applied: response.applied === true,
            ...(typeof response.reason === "string" ? { reason: response.reason } : {}),
          };
        } catch (error) {
          if (state.closed || NON_RETRYABLE_CODES.has(error?.code)) throw error;
          lastError = error;
          diagnostic(
            "send_failed",
            `pip-session send attempt ${attempt + 1} failed: ${String(error)}`,
          );
          if (state.readySocket) terminate(state.readySocket, error);
          if (attempt < reconnectAttempts) {
            await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
          }
        }
      }
      throw lastError ?? codedError("pip-session send failed", "send_failed");
    },

    close() {
      if (state.closed) return;
      state.closed = true;
      state.readySocket = undefined;
      const error = codedError("pip-session client closed", "closed");
      for (const socket of state.sockets) terminate(socket, error);
      state.connecting = undefined;
    },
  };
}
