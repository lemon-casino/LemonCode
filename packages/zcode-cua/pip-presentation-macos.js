import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

const PRESENTER_PATH_ENV = "ZCODE_CUA_PIP_PRESENTER";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_ERROR_TEXT_BYTES = 4 * 1024;

function codedError(message, code = "presenter_unavailable") {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function positiveTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function writeLine(stream, frame) {
  return new Promise((resolve, reject) => {
    const line = `${JSON.stringify(frame)}\n`;
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    stream.once("error", onError);
    if (stream.write(line)) {
      stream.off("error", onError);
      resolve();
    } else {
      stream.once("drain", onDrain);
    }
  });
}

export async function createMacOsPipPresenter(options = {}) {
  const env = options.env ?? process.env;
  const executablePath =
    typeof options.executablePath === "string" && options.executablePath.trim()
      ? options.executablePath.trim()
      : env[PRESENTER_PATH_ENV]?.trim();
  if (!executablePath) {
    throw codedError("Computer Use PiP presenter executable is unavailable");
  }
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const spawn = options.spawn ?? spawnChild;
  const child = spawn(executablePath, [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child?.stdin || !child.stdout || !child.stderr) {
    child?.kill?.();
    throw codedError("Computer Use PiP presenter process has invalid stdio");
  }

  let stderr = "";
  let stdoutBuffer = Buffer.alloc(0);
  let ready = false;
  let closed = false;
  let pending;
  let tail = Promise.resolve();
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const fail = (error) => {
    const failure =
      error instanceof Error ? error : codedError("Computer Use PiP presenter became unavailable");
    if (!ready) rejectReady(failure);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    if (!closed) child.kill?.();
  };

  const handleFrame = (frame) => {
    if (!ready) {
      if (
        !isRecord(frame) ||
        !hasExactKeys(frame, new Set(["type", "version"])) ||
        frame.type !== "ready" ||
        frame.version !== 1
      ) {
        fail(codedError("Computer Use PiP presenter returned an invalid ready frame"));
        return;
      }
      ready = true;
      resolveReady();
      return;
    }
    if (
      !pending ||
      !isRecord(frame) ||
      typeof frame.id !== "string" ||
      frame.id !== pending.id ||
      (frame.type !== "applied" && frame.type !== "error") ||
      !hasExactKeys(
        frame,
        frame.type === "applied" ? new Set(["id", "type"]) : new Set(["id", "type", "error"]),
      ) ||
      (frame.type === "error" && typeof frame.error !== "string")
    ) {
      fail(codedError("Computer Use PiP presenter returned an invalid acknowledgement"));
      return;
    }
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    if (frame.type === "applied") current.resolve();
    else
      current.reject(codedError(`Computer Use PiP presenter rejected a command: ${frame.error}`));
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    for (;;) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (stdoutBuffer.length > MAX_CONTROL_FRAME_BYTES) {
          fail(codedError("Computer Use PiP presenter response exceeded its limit"));
        }
        return;
      }
      if (newline > MAX_CONTROL_FRAME_BYTES) {
        fail(codedError("Computer Use PiP presenter response exceeded its limit"));
        return;
      }
      const bytes = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (bytes.length === 0) continue;
      let line;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail(codedError("Computer Use PiP presenter response is not valid UTF-8"));
        return;
      }
      try {
        handleFrame(JSON.parse(line));
      } catch {
        fail(codedError("Computer Use PiP presenter response is not valid JSON"));
        return;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderr, "utf8") >= MAX_ERROR_TEXT_BYTES) return;
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr, "utf8") > MAX_ERROR_TEXT_BYTES) {
      stderr = Buffer.from(stderr, "utf8").subarray(0, MAX_ERROR_TEXT_BYTES).toString("utf8");
    }
  });
  child.once("error", (error) =>
    fail(codedError(`Computer Use PiP presenter failed: ${error.message}`)),
  );
  // `exit` 可能先于最后一次 stdout data；只有 `close` 才表示 stdio 已排空，
  // 因此不能在 `exit` 时把仍在路上的 ACK 误判为失败。
  child.once("close", (code, signal) => {
    closed = true;
    resolveExit({ code, signal });
    if (!ready || pending) {
      const detail = stderr.trim();
      fail(
        codedError(
          `Computer Use PiP presenter exited before acknowledgement${detail ? `: ${detail}` : ""}`,
        ),
      );
    }
  });

  const readyTimer = setTimeout(() => {
    fail(codedError("Computer Use PiP presenter startup timed out"));
  }, timeoutMs);
  try {
    await readyPromise;
  } finally {
    clearTimeout(readyTimer);
  }

  const send = (command) => {
    const operation = tail.then(async () => {
      if (closed) throw codedError("Computer Use PiP presenter is closed");
      const id = randomUUID();
      const acknowledgement = new Promise((resolve, reject) => {
        pending = {
          id,
          resolve,
          reject,
          timer: setTimeout(() => {
            pending = undefined;
            const error = codedError("Computer Use PiP presenter command timed out");
            reject(error);
            fail(error);
          }, timeoutMs),
        };
      });
      try {
        await writeLine(child.stdin, { id, ...command });
        await acknowledgement;
      } catch (error) {
        if (pending?.id === id) {
          clearTimeout(pending.timer);
          pending = undefined;
        }
        fail(error);
        throw error;
      }
    });
    tail = operation.catch(() => undefined);
    return operation;
  };

  return {
    show(capture) {
      return send({
        type: "show",
        pngBase64: capture.data,
        width: capture.width,
        height: capture.height,
        ...(capture.title ? { title: capture.title } : {}),
      });
    },
    hide() {
      return send({ type: "hide" });
    },
    async dispose() {
      if (closed) return;
      try {
        await send({ type: "close" });
        child.stdin.end();
        const exitTimeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
        await Promise.race([exited, exitTimeout]);
      } finally {
        if (!closed) child.kill?.();
      }
    },
  };
}
