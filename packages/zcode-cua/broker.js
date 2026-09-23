/* oxlint-disable eslint(max-lines) -- Client framing and server protocol helpers share one public broker contract in this module. */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { HELPER_CONTROL_PROTOCOL } from "./broker-helper-constants.js";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
export const BROKER_CAPABILITY_ENV = "ZCODE_CUA_PERMISSION_BROKER_CAPABILITY";
export const BROKER_GENERATION_ENV = "ZCODE_CUA_PERMISSION_BROKER_GENERATION";

export const BROKER_PROTOCOL_ID = "zcode.cua/broker";
export const BROKER_PROTOCOL_VERSION = 1;
export const MAX_BROKER_REQUEST_BYTES = 1024 * 1024;
export const MAX_BROKER_RESPONSE_BYTES = 32 * 1024 * 1024;

const DEFAULT_CALL_TIMEOUT_MS = 5000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 50;
const DEFAULT_HEALTH_TRY_TIMEOUT_MS = 500;
const MAX_HELPER_BOOTSTRAP_NONCE_BYTES = 256;
const MAX_HELPER_BOOTSTRAP_CAPABILITY_BYTES = 4096;
const BROKER_METHODS = new Set([
  "ping",
  "broker_info",
  "permission_status",
  "execute",
  "close_session",
  "shutdown",
]);
const READ_ONLY_BROKER_METHODS = new Set(["ping", "broker_info", "permission_status"]);
// permission_status 是既有 macOS 本机签名身份通道的只读查询；它不触发授权提示或输入，
// 因此与健康探测同样允许无 wire capability。所有有副作用的方法仍强制凭据。
const ANONYMOUS_BROKER_METHODS = new Set(["ping", "broker_info", "permission_status"]);
const REQUEST_KEYS = new Set([
  "id",
  "protocol",
  "version",
  "capability",
  "generation",
  "method",
  "params",
]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
    if (options.possiblySent !== undefined) this.possiblySent = options.possiblySent;
    if (options.retryable !== undefined) this.retryable = options.retryable;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
    if (options.details !== undefined) this.details = options.details;
    if (options.possiblySent !== undefined) this.possiblySent = options.possiblySent;
    if (options.retryable !== undefined) this.retryable = options.retryable;
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

function isBoundedBootstrapString(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isBootstrapPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseHelperBootstrapRequest(value) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, new Set(["protocol", "type", "pid", "nonce"])) ||
    value.protocol !== HELPER_CONTROL_PROTOCOL ||
    value.type !== "bootstrap_request" ||
    !isBootstrapPid(value.pid) ||
    !isBoundedBootstrapString(value.nonce, MAX_HELPER_BOOTSTRAP_NONCE_BYTES)
  ) {
    return undefined;
  }
  return value;
}

export function createHelperBootstrapRequest(options = {}) {
  const request = {
    protocol: HELPER_CONTROL_PROTOCOL,
    type: "bootstrap_request",
    pid: options.pid,
    nonce: options.nonce ?? randomUUID(),
  };
  if (!parseHelperBootstrapRequest(request)) {
    throw new CuaHelperError("Helper credential bootstrap request is invalid.", {
      code: "invalid_request",
    });
  }
  return request;
}

export function parseHelperBootstrapCredentials(value) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      new Set(["protocol", "type", "pid", "nonce", "capability", "generation"]),
    ) ||
    value.protocol !== HELPER_CONTROL_PROTOCOL ||
    value.type !== "bootstrap_credentials" ||
    !isBootstrapPid(value.pid) ||
    !isBoundedBootstrapString(value.nonce, MAX_HELPER_BOOTSTRAP_NONCE_BYTES) ||
    !isBoundedBootstrapString(value.capability, MAX_HELPER_BOOTSTRAP_CAPABILITY_BYTES) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    return undefined;
  }
  return value;
}

export function createHelperBootstrapCredentials(options = {}) {
  const credentials = {
    protocol: HELPER_CONTROL_PROTOCOL,
    type: "bootstrap_credentials",
    pid: options.pid,
    nonce: options.nonce,
    capability: options.capability,
    generation: options.generation,
  };
  if (!parseHelperBootstrapCredentials(credentials)) {
    throw new CuaHelperError("Helper credential bootstrap response is invalid.", {
      code: "invalid_request",
    });
  }
  return credentials;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, required, optional = new Set()) {
  const keys = Object.keys(value);
  if (keys.length < required.size || keys.length > required.size + optional.size) return false;
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return keys.every((key) => required.has(key) || optional.has(key));
}

function isRequestId(value) {
  return (
    (typeof value === "string" && value.length > 0) || (Number.isSafeInteger(value) && value >= 0)
  );
}

function isCredentialPair(capability, generation) {
  if (capability === null || generation === null) return capability === null && generation === null;
  return (
    typeof capability === "string" &&
    capability.length > 0 &&
    capability === capability.trim() &&
    Number.isSafeInteger(generation) &&
    generation >= 0
  );
}

function validateRequest(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, REQUEST_KEYS)) {
    throw new BrokerError("Invalid Computer Use broker request.", { code: "invalid_request" });
  }
  if (
    !isRequestId(value.id) ||
    value.protocol !== BROKER_PROTOCOL_ID ||
    value.version !== BROKER_PROTOCOL_VERSION ||
    !isCredentialPair(value.capability, value.generation) ||
    !isBrokerMethod(value.method) ||
    !isPlainObject(value.params)
  ) {
    throw new BrokerError("Invalid Computer Use broker request.", { code: "invalid_request" });
  }
  if (
    value.capability === null &&
    (!ANONYMOUS_BROKER_METHODS.has(value.method) || value.generation !== null)
  ) {
    throw new BrokerError("Computer Use broker authorization is required.", {
      code: "not_authorized",
    });
  }
  return value;
}

function parseRequestLineOrThrow(line) {
  if (typeof line !== "string" || line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new BrokerError("Invalid Computer Use broker request.", { code: "invalid_request" });
  }
  if (Buffer.byteLength(line, "utf8") > MAX_BROKER_REQUEST_BYTES) {
    throw new BrokerError("Computer Use broker request exceeded the 1 MiB limit.", {
      code: "request_too_large",
    });
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new BrokerError("Invalid Computer Use broker request.", { code: "invalid_request" });
  }
  return validateRequest(value);
}

function normalizePositiveTimeout(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new BrokerError(`${name} must be a positive finite number.`, {
      code: "invalid_request",
    });
  }
  return value;
}

function normalizeNonNegativeTimeout(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new BrokerError(`${name} must be a non-negative finite number.`, {
      code: "invalid_request",
    });
  }
  return value;
}

function transportError(message, code, method, sent, details) {
  return new BrokerError(message, {
    code,
    details,
    possiblySent: sent && !isReadOnlyBrokerMethod(method),
    retryable: isReadOnlyBrokerMethod(method),
  });
}

function serializeRequest(args, allowAnonymous) {
  const method = args?.method;
  const capability = allowAnonymous ? (args.capability ?? null) : args?.capability;
  const generation = allowAnonymous ? (args.generation ?? null) : args?.generation;
  const frame = validateRequest({
    id: randomUUID(),
    protocol: BROKER_PROTOCOL_ID,
    version: BROKER_PROTOCOL_VERSION,
    capability,
    generation,
    method,
    params: args?.params ?? {},
  });
  let line;
  try {
    line = JSON.stringify(frame);
  } catch {
    throw new BrokerError("Computer Use broker request is not JSON serializable.", {
      code: "invalid_request",
    });
  }
  if (Buffer.byteLength(line, "utf8") > MAX_BROKER_REQUEST_BYTES) {
    throw new BrokerError("Computer Use broker request exceeded the 1 MiB limit.", {
      code: "request_too_large",
      possiblySent: false,
      retryable: isReadOnlyBrokerMethod(method),
    });
  }
  return { frame, wire: `${line}\n` };
}

function parseResponseLine(line, expectedId) {
  if (typeof line !== "string" || line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new BrokerError("Computer Use broker returned an invalid response.", {
      code: "invalid_response",
    });
  }
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    throw new BrokerError("Computer Use broker returned a non-JSON response.", {
      code: "invalid_response",
    });
  }
  if (!isPlainObject(response) || response.id !== expectedId || typeof response.ok !== "boolean") {
    throw new BrokerError("Computer Use broker returned an invalid response envelope.", {
      code: "invalid_response",
    });
  }
  if (response.ok) {
    if (
      !hasExactKeys(response, new Set(["id", "ok", "result"]), new Set(["responseMeta"])) ||
      (Object.hasOwn(response, "responseMeta") && !isPlainObject(response.responseMeta))
    ) {
      throw new BrokerError("Computer Use broker returned an invalid success response.", {
        code: "invalid_response",
      });
    }
    return response;
  }
  if (!hasExactKeys(response, new Set(["id", "ok", "error"])) || !isPlainObject(response.error)) {
    throw new BrokerError("Computer Use broker returned an invalid error response.", {
      code: "invalid_response",
    });
  }
  const error = response.error;
  if (
    !hasExactKeys(
      error,
      new Set(["code", "message"]),
      new Set(["details", "possibly_sent", "retryable"]),
    ) ||
    typeof error.code !== "string" ||
    error.code.length === 0 ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    (Object.hasOwn(error, "possibly_sent") && typeof error.possibly_sent !== "boolean") ||
    (Object.hasOwn(error, "retryable") && typeof error.retryable !== "boolean")
  ) {
    throw new BrokerError("Computer Use broker returned an invalid error payload.", {
      code: "invalid_response",
    });
  }
  return response;
}

async function callBrokerMethodInternal(args, allowAnonymous) {
  const socketPath = typeof args?.socketPath === "string" ? args.socketPath.trim() : "";
  if (!socketPath) {
    throw new BrokerError("Computer Use broker socket path is required.", {
      code: "invalid_request",
      possiblySent: false,
    });
  }
  const timeoutMs = normalizePositiveTimeout(args.timeoutMs, DEFAULT_CALL_TIMEOUT_MS, "timeoutMs");
  const { frame, wire } = serializeRequest(args, allowAnonymous);
  const signal = args.signal;
  if (signal?.aborted) {
    throw transportError(
      "Computer Use broker request was aborted.",
      "aborted",
      frame.method,
      false,
    );
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let responseBytes = 0;
    const responseChunks = [];
    const socket = createConnection(socketPath);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const failTransport = (message, code, details) =>
      settle(transportError(message, code, frame.method, sent, details));
    const onAbort = () => failTransport("Computer Use broker request was aborted.", "aborted");
    const timer = setTimeout(
      () => failTransport("Computer Use broker request timed out.", "timeout"),
      timeoutMs,
    );

    signal?.addEventListener?.("abort", onAbort, { once: true });
    socket.setNoDelay(true);
    socket.once("connect", () => {
      try {
        socket.write(wire);
        sent = true;
      } catch (error) {
        failTransport("Computer Use broker request could not be written.", "unavailable", {
          cause: error instanceof Error ? (error.code ?? error.name) : typeof error,
        });
      }
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      const newline = chunk.indexOf(0x0a);
      const lineChunk = newline < 0 ? chunk : chunk.subarray(0, newline);
      responseBytes += lineChunk.length;
      if (responseBytes > MAX_BROKER_RESPONSE_BYTES) {
        failTransport(
          "Computer Use broker response exceeded the 32 MiB limit.",
          "response_too_large",
        );
        return;
      }
      responseChunks.push(lineChunk);
      if (newline < 0) return;
      if (newline !== chunk.length - 1) {
        failTransport(
          "Computer Use broker returned more than one response frame.",
          "invalid_response",
        );
        return;
      }
      let line;
      try {
        line = utf8Decoder.decode(Buffer.concat(responseChunks, responseBytes));
      } catch {
        failTransport("Computer Use broker returned invalid UTF-8.", "invalid_response");
        return;
      }
      let response;
      try {
        response = parseResponseLine(line, frame.id);
      } catch (error) {
        const protocolError =
          error instanceof BrokerError
            ? error
            : new BrokerError("Computer Use broker returned an invalid response.", {
                code: "invalid_response",
              });
        protocolError.possiblySent = sent && !isReadOnlyBrokerMethod(frame.method);
        protocolError.retryable = isReadOnlyBrokerMethod(frame.method);
        settle(protocolError);
        return;
      }
      if (!response.ok) {
        settle(
          new BrokerError(response.error.message, {
            code: response.error.code,
            details: response.error.details,
            possiblySent: response.error.possibly_sent,
            retryable: response.error.retryable,
          }),
        );
        return;
      }
      settle(undefined, response.result);
    });
    socket.once("error", (error) => {
      failTransport("Computer Use broker is unavailable.", "unavailable", {
        cause: error instanceof Error ? (error.code ?? error.name) : typeof error,
      });
    });
    socket.once("close", () => {
      if (!settled) {
        failTransport("Computer Use broker closed before replying.", "unavailable");
      }
    });
  });
}

export async function callBrokerMethod(args) {
  return await callBrokerMethodInternal(args, ANONYMOUS_BROKER_METHODS.has(args?.method));
}

function validateHelperHealth(value) {
  if (!isPlainObject(value)) return undefined;
  const bundleId = value.bundleId;
  const pid = value.pid;
  if (bundleId !== null && (typeof bundleId !== "string" || bundleId.length === 0))
    return undefined;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) return undefined;
  if (!Object.hasOwn(value, "bundleId") || !Object.hasOwn(value, "pid")) return undefined;
  return { bundleId, pid };
}

function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BrokerError("Computer Use broker health probe was aborted.", { code: "aborted" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export async function probeHelperHealth(socketPath, options = {}) {
  const timeoutMs = normalizePositiveTimeout(
    options.timeoutMs,
    DEFAULT_CALL_TIMEOUT_MS,
    "timeoutMs",
  );
  const pollIntervalMs = normalizeNonNegativeTimeout(
    options.pollIntervalMs,
    DEFAULT_HEALTH_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const perTryTimeoutMs = normalizePositiveTimeout(
    options.perTryTimeoutMs,
    DEFAULT_HEALTH_TRY_TIMEOUT_MS,
    "perTryTimeoutMs",
  );
  const hasCapability = options.capability !== undefined;
  const hasGeneration = options.generation !== undefined;
  if (hasCapability !== hasGeneration) {
    throw new BrokerError("Health probe capability and generation must be provided together.", {
      code: "invalid_request",
    });
  }

  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    if (options.signal?.aborted) {
      throw new BrokerError("Computer Use broker health probe was aborted.", { code: "aborted" });
    }
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const result = await callBrokerMethodInternal(
        {
          socketPath,
          capability: hasCapability ? options.capability : null,
          generation: hasGeneration ? options.generation : null,
          method: "broker_info",
          params: {},
          timeoutMs: Math.min(perTryTimeoutMs, remaining),
          signal: options.signal,
        },
        !hasCapability,
      );
      const health = validateHelperHealth(result);
      if (!health) {
        throw new BrokerError("Computer Use Helper returned invalid health information.", {
          code: "invalid_response",
        });
      }
      return health;
    } catch (error) {
      if (
        error instanceof BrokerError &&
        (error.code === "aborted" || error.code === "invalid_request")
      ) {
        throw error;
      }
      lastError = error;
    }
    const remainingAfterTry = deadline - Date.now();
    if (remainingAfterTry <= 0) break;
    await abortableDelay(Math.min(pollIntervalMs, remainingAfterTry), options.signal);
  } while (Date.now() < deadline);

  throw new BrokerError("Computer Use Helper health probe timed out.", {
    code: "timeout",
    details: {
      lastErrorCode: lastError instanceof BrokerError ? lastError.code : undefined,
    },
    retryable: true,
  });
}

export function mintBrokerSocketPath(options = {}) {
  if ((options.platform ?? process.platform) === "win32") {
    return `\\\\.\\pipe\\zcode-cua-broker-${randomUUID()}`;
  }
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}

export function parseRequestLine(line) {
  try {
    return parseRequestLineOrThrow(line);
  } catch {
    return undefined;
  }
}

export function okResponse(result, options = {}) {
  return {
    ...(options.id !== undefined ? { id: options.id } : {}),
    ok: true,
    result: result === undefined ? null : result,
    ...(options.responseMeta !== undefined ? { responseMeta: options.responseMeta } : {}),
  };
}

export function errorResponse(message, options = {}) {
  return {
    ...(options.id !== undefined ? { id: options.id } : {}),
    ok: false,
    error: {
      code: options.code ?? "internal_error",
      message:
        typeof message === "string" && message.length > 0
          ? message
          : "Computer Use Helper request failed.",
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(options.possiblySent !== undefined ? { possibly_sent: options.possiblySent } : {}),
      ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
    },
  };
}

export function errorResponseFromException(error, options = {}) {
  const known = error instanceof BrokerError || error instanceof CuaHelperError;
  return errorResponse(error instanceof Error ? error.message : String(error), {
    ...options,
    code: known ? error.code : (options.code ?? "internal_error"),
    details: known ? error.details : options.details,
    possiblySent: known ? error.possiblySent : options.possiblySent,
    retryable: known ? error.retryable : options.retryable,
  });
}

export function serializeResponse(response) {
  let line;
  try {
    line = JSON.stringify(response);
  } catch {
    throw new CuaHelperError("Computer Use broker response is not JSON serializable.", {
      code: "invalid_response",
    });
  }
  if (typeof line !== "string") {
    throw new CuaHelperError("Computer Use broker response is invalid.", {
      code: "invalid_response",
    });
  }
  if (Buffer.byteLength(line, "utf8") > MAX_BROKER_RESPONSE_BYTES) {
    throw new CuaHelperError("Computer Use broker response exceeded the 32 MiB limit.", {
      code: "response_too_large",
    });
  }
  return `${line}\n`;
}

export async function dispatchRequest(backend, request) {
  let validated;
  try {
    validated = validateRequest(request);
  } catch (error) {
    return errorResponseFromException(error, {
      id: isPlainObject(request) && isRequestId(request.id) ? request.id : undefined,
    });
  }

  const anonymous = validated.capability === null;
  try {
    if (!anonymous) {
      if (
        typeof backend?.authorize !== "function" ||
        (await backend.authorize(validated)) !== true
      ) {
        throw new BrokerError("Computer Use broker authorization failed.", {
          code: "not_authorized",
        });
      }
    }
    const context = {
      request: validated,
      anonymous,
      readOnly: isReadOnlyBrokerMethod(validated.method),
    };
    let result;
    if (typeof backend?.[validated.method] === "function") {
      result = await backend[validated.method](validated.params, context);
    } else if (typeof backend?.dispatch === "function") {
      result = await backend.dispatch(validated.method, validated.params, context);
    } else {
      throw new CuaHelperError("Computer Use broker method is unavailable.", {
        code: "method_unavailable",
      });
    }
    if (
      isPlainObject(result) &&
      Object.hasOwn(result, "responseMeta") &&
      hasExactKeys(result, new Set(["result"]), new Set(["responseMeta"]))
    ) {
      return okResponse(result.result, {
        id: validated.id,
        responseMeta: result.responseMeta,
      });
    }
    return okResponse(result, { id: validated.id });
  } catch (error) {
    return errorResponseFromException(error, { id: validated.id });
  }
}

export async function handleRequestLine(backend, line) {
  let request;
  try {
    request = parseRequestLineOrThrow(line);
  } catch (error) {
    return errorResponseFromException(error);
  }
  return await dispatchRequest(backend, request);
}

export function isBrokerMethod(method) {
  return typeof method === "string" && BROKER_METHODS.has(method);
}

export function isReadOnlyBrokerMethod(method) {
  return typeof method === "string" && READ_ONLY_BROKER_METHODS.has(method);
}
