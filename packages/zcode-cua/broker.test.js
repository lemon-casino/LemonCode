/* oxlint-disable eslint(max-lines) -- Protocol unit cases and real socket edge cases stay aligned in one contract suite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";

import {
  BROKER_PROTOCOL_ID,
  BROKER_PROTOCOL_VERSION,
  BrokerError,
  MAX_BROKER_REQUEST_BYTES,
  MAX_BROKER_RESPONSE_BYTES,
  callBrokerMethod,
  createHelperBootstrapCredentials,
  createHelperBootstrapRequest,
  dispatchRequest,
  errorResponse,
  errorResponseFromException,
  handleRequestLine,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  mintBrokerSocketPath,
  okResponse,
  parseHelperBootstrapCredentials,
  parseHelperBootstrapRequest,
  parseRequestLine,
  probeHelperHealth,
  serializeResponse,
} from "./broker.js";

const CAPABILITY = "a".repeat(64);
const GENERATION = 7;

test("helper bootstrap messages require exact bounded credential envelopes", () => {
  const request = createHelperBootstrapRequest({ pid: 42, nonce: "challenge" });
  assert.deepEqual(parseHelperBootstrapRequest(request), request);
  const credentials = createHelperBootstrapCredentials({
    ...request,
    capability: CAPABILITY,
    generation: GENERATION,
  });
  assert.deepEqual(parseHelperBootstrapCredentials(credentials), credentials);

  for (const invalid of [
    { ...request, extra: true },
    { ...request, pid: 0 },
    { ...request, nonce: "" },
    { ...request, nonce: "x".repeat(257) },
  ]) {
    assert.equal(parseHelperBootstrapRequest(invalid), undefined);
  }
  for (const invalid of [
    { ...credentials, extra: true },
    { ...credentials, capability: "" },
    { ...credentials, capability: "x".repeat(4097) },
    { ...credentials, generation: -1 },
  ]) {
    assert.equal(parseHelperBootstrapCredentials(invalid), undefined);
  }
});

function request(overrides = {}) {
  return {
    id: "request-1",
    protocol: BROKER_PROTOCOL_ID,
    version: BROKER_PROTOCOL_VERSION,
    capability: CAPABILITY,
    generation: GENERATION,
    method: "ping",
    params: {},
    ...overrides,
  };
}

async function listen(handler) {
  const socketPath = mintBrokerSocketPath();
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function readOneLine(socket, onLine) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    socket.removeAllListeners("data");
    onLine(buffer.subarray(0, newline).toString("utf8"));
  });
}

test("broker method classification is closed over the six protocol methods", () => {
  for (const method of [
    "ping",
    "broker_info",
    "permission_status",
    "execute",
    "close_session",
    "shutdown",
  ]) {
    assert.equal(isBrokerMethod(method), true);
  }
  assert.equal(isBrokerMethod("capture_app"), false);
  assert.equal(isBrokerMethod("toString"), false);
  assert.equal(isBrokerMethod(1), false);

  assert.equal(isReadOnlyBrokerMethod("ping"), true);
  assert.equal(isReadOnlyBrokerMethod("broker_info"), true);
  assert.equal(isReadOnlyBrokerMethod("permission_status"), true);
  assert.equal(isReadOnlyBrokerMethod("execute"), false);
  assert.equal(isReadOnlyBrokerMethod("shutdown"), false);
});

test("parseRequestLine accepts only the exact v1 request envelope", () => {
  assert.deepEqual(parseRequestLine(JSON.stringify(request())), request());
  assert.deepEqual(parseRequestLine(JSON.stringify(request({ id: 0 }))), request({ id: 0 }));
  assert.deepEqual(
    parseRequestLine(
      JSON.stringify(request({ capability: null, generation: null, method: "broker_info" })),
    ),
    request({ capability: null, generation: null, method: "broker_info" }),
  );

  const invalid = [
    "",
    "not-json",
    "[]",
    JSON.stringify({ ...request(), extra: true }),
    JSON.stringify(request({ protocol: "other" })),
    JSON.stringify(request({ version: 2 })),
    JSON.stringify(request({ id: "" })),
    JSON.stringify(request({ id: -1 })),
    JSON.stringify(request({ capability: "" })),
    JSON.stringify(request({ capability: null, generation: null, method: "execute" })),
    JSON.stringify(request({ generation: -1 })),
    JSON.stringify(request({ generation: 1.5 })),
    JSON.stringify(request({ method: "capture_app" })),
    JSON.stringify(request({ params: [] })),
    `${JSON.stringify(request())}\n`,
    "x".repeat(MAX_BROKER_REQUEST_BYTES + 1),
  ];
  for (const line of invalid) assert.equal(parseRequestLine(line), undefined);

  const missingParams = request();
  delete missingParams.params;
  assert.equal(parseRequestLine(JSON.stringify(missingParams)), undefined);
});

test("response factories preserve protocol errors and serialize one guarded line", () => {
  assert.deepEqual(okResponse({ pong: true }, { id: "a" }), {
    id: "a",
    ok: true,
    result: { pong: true },
  });
  assert.deepEqual(
    errorResponse("denied", {
      id: "a",
      code: "not_authorized",
      details: { permission: "accessibility" },
      possiblySent: false,
      retryable: true,
    }),
    {
      id: "a",
      ok: false,
      error: {
        code: "not_authorized",
        message: "denied",
        details: { permission: "accessibility" },
        possibly_sent: false,
        retryable: true,
      },
    },
  );

  const exception = new BrokerError("stale generation", {
    code: "stale_generation",
    details: { expected: 8 },
    possiblySent: false,
    retryable: false,
  });
  assert.deepEqual(errorResponseFromException(exception, { id: 9 }), {
    id: 9,
    ok: false,
    error: {
      code: "stale_generation",
      message: "stale generation",
      details: { expected: 8 },
      possibly_sent: false,
      retryable: false,
    },
  });
  assert.equal(
    serializeResponse(okResponse(null, { id: 1 })),
    '{"id":1,"ok":true,"result":null}\n',
  );
  assert.throws(
    () => serializeResponse(okResponse("x".repeat(MAX_BROKER_RESPONSE_BYTES), { id: 1 })),
    (error) => error?.code === "response_too_large",
  );
});

test("dispatchRequest authorizes before invoking an injected method handler", async () => {
  let calls = 0;
  const backend = {
    authorize: async (value) => value.capability === CAPABILITY,
    ping: async (params, context) => {
      calls += 1;
      assert.deepEqual(params, {});
      assert.equal(context.request.generation, GENERATION);
      return { pong: true };
    },
  };

  assert.deepEqual(await dispatchRequest(backend, request()), {
    id: "request-1",
    ok: true,
    result: { pong: true },
  });
  assert.equal(calls, 1);

  assert.equal(
    (await dispatchRequest({ ping: backend.ping }, request())).error.code,
    "not_authorized",
  );
  assert.equal(
    (await dispatchRequest({ authorize: () => false, ping: backend.ping }, request())).error.code,
    "not_authorized",
  );
  assert.equal(calls, 1);
});

test("dispatchRequest supports a generic backend and maps handler failures", async () => {
  assert.deepEqual(
    await dispatchRequest(
      {
        authorize: () => true,
        dispatch: () => ({ result: { content: [] }, responseMeta: { app: "editor" } }),
      },
      request({ method: "execute" }),
    ),
    {
      id: "request-1",
      ok: true,
      result: { content: [] },
      responseMeta: { app: "editor" },
    },
  );

  const generic = {
    authorize: () => true,
    dispatch: async (method) => {
      assert.equal(method, "execute");
      throw new BrokerError("element disappeared", {
        code: "element_unavailable",
        possiblySent: true,
      });
    },
  };
  const response = await dispatchRequest(generic, request({ method: "execute" }));
  assert.equal(response.id, "request-1");
  assert.equal(response.ok, false);
  assert.deepEqual(response.error, {
    code: "element_unavailable",
    message: "element disappeared",
    possibly_sent: true,
  });
});

test("handleRequestLine fails malformed input without invoking the backend", async () => {
  let calls = 0;
  const backend = {
    authorize: () => true,
    ping: () => {
      calls += 1;
      return null;
    },
  };
  assert.equal((await handleRequestLine(backend, "bad-json")).error.code, "invalid_request");
  assert.equal(calls, 0);
  assert.deepEqual(await handleRequestLine(backend, JSON.stringify(request())), {
    id: "request-1",
    ok: true,
    result: null,
  });
  assert.equal(calls, 1);
});

test("callBrokerMethod sends the v1 envelope and accepts a fragmented response", async () => {
  let observed;
  const peer = await listen((socket) => {
    readOneLine(socket, (line) => {
      observed = JSON.parse(line);
      const response = serializeResponse(okResponse({ pong: true }, { id: observed.id }));
      socket.write(response.slice(0, 5));
      socket.end(response.slice(5));
    });
  });
  try {
    assert.deepEqual(
      await callBrokerMethod({
        socketPath: peer.socketPath,
        capability: CAPABILITY,
        generation: GENERATION,
        method: "ping",
        params: {},
      }),
      { pong: true },
    );
    assert.equal(observed.protocol, BROKER_PROTOCOL_ID);
    assert.equal(observed.version, BROKER_PROTOCOL_VERSION);
    assert.equal(observed.capability, CAPABILITY);
    assert.equal(observed.generation, GENERATION);
    assert.equal(typeof observed.id, "string");
  } finally {
    await peer.close();
  }
});

test("callBrokerMethod rejects server errors, id mismatches, and extra frames", async (t) => {
  await t.test("server error", async () => {
    const peer = await listen((socket) => {
      readOneLine(socket, (line) => {
        const { id } = JSON.parse(line);
        socket.end(
          serializeResponse(
            errorResponse("denied", {
              id,
              code: "not_authorized",
              possiblySent: false,
              retryable: false,
            }),
          ),
        );
      });
    });
    try {
      await assert.rejects(
        callBrokerMethod({
          socketPath: peer.socketPath,
          capability: CAPABILITY,
          generation: GENERATION,
          method: "execute",
          params: {},
        }),
        (error) =>
          error?.code === "not_authorized" &&
          error?.possiblySent === false &&
          error?.retryable === false,
      );
    } finally {
      await peer.close();
    }
  });

  await t.test("mismatched id", async () => {
    const peer = await listen((socket) => {
      readOneLine(socket, () => socket.end(serializeResponse(okResponse(null, { id: "wrong" }))));
    });
    try {
      await assert.rejects(
        callBrokerMethod({
          socketPath: peer.socketPath,
          capability: CAPABILITY,
          generation: GENERATION,
          method: "ping",
        }),
        (error) => error?.code === "invalid_response",
      );
    } finally {
      await peer.close();
    }
  });

  await t.test("more than one response frame", async () => {
    const peer = await listen((socket) => {
      readOneLine(socket, (line) => {
        const { id } = JSON.parse(line);
        const response = serializeResponse(okResponse(null, { id }));
        socket.end(response + response);
      });
    });
    try {
      await assert.rejects(
        callBrokerMethod({
          socketPath: peer.socketPath,
          capability: CAPABILITY,
          generation: GENERATION,
          method: "ping",
        }),
        (error) => error?.code === "invalid_response",
      );
    } finally {
      await peer.close();
    }
  });
});

test("callBrokerMethod enforces request/response limits, timeout, and abort", async (t) => {
  await t.test("request too large", async () => {
    await assert.rejects(
      callBrokerMethod({
        socketPath: mintBrokerSocketPath(),
        capability: CAPABILITY,
        generation: GENERATION,
        method: "execute",
        params: { text: "x".repeat(MAX_BROKER_REQUEST_BYTES) },
      }),
      (error) => error?.code === "request_too_large" && error?.possiblySent === false,
    );
  });

  await t.test("response too large", async () => {
    const peer = await listen((socket) => {
      readOneLine(socket, () => socket.end(Buffer.alloc(MAX_BROKER_RESPONSE_BYTES + 1, 0x20)));
    });
    try {
      await assert.rejects(
        callBrokerMethod({
          socketPath: peer.socketPath,
          capability: CAPABILITY,
          generation: GENERATION,
          method: "ping",
        }),
        (error) => error?.code === "response_too_large" && error?.retryable === true,
      );
    } finally {
      await peer.close();
    }
  });

  await t.test("timeout after a mutating request may have been sent", async () => {
    const peer = await listen((socket) => readOneLine(socket, () => {}));
    try {
      await assert.rejects(
        callBrokerMethod({
          socketPath: peer.socketPath,
          capability: CAPABILITY,
          generation: GENERATION,
          method: "execute",
          timeoutMs: 25,
        }),
        (error) => error?.code === "timeout" && error?.possiblySent === true,
      );
    } finally {
      await peer.close();
    }
  });

  await t.test("pre-aborted signal does not connect", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      callBrokerMethod({
        socketPath: mintBrokerSocketPath(),
        capability: CAPABILITY,
        generation: GENERATION,
        method: "ping",
        signal: controller.signal,
      }),
      (error) =>
        error?.code === "aborted" && error?.possiblySent === false && error?.retryable === true,
    );
  });
});

test("probeHelperHealth calls broker_info and validates the health payload", async () => {
  let observed;
  const peer = await listen((socket) => {
    readOneLine(socket, (line) => {
      const frame = JSON.parse(line);
      observed = frame;
      assert.equal(frame.method, "broker_info");
      socket.end(
        serializeResponse(
          okResponse(
            { bundleId: "com.zcode.helper", pid: 42, protocolVersion: 1 },
            { id: frame.id },
          ),
        ),
      );
    });
  });
  try {
    assert.deepEqual(
      await probeHelperHealth(peer.socketPath, {
        timeoutMs: 200,
        perTryTimeoutMs: 100,
        pollIntervalMs: 1,
      }),
      { bundleId: "com.zcode.helper", pid: 42 },
    );
    assert.equal(observed.capability, null);
    assert.equal(observed.generation, null);
  } finally {
    await peer.close();
  }
});

test("mintBrokerSocketPath produces a connectable platform socket name", () => {
  const path = mintBrokerSocketPath();
  assert.equal(typeof path, "string");
  assert.ok(path.includes("zcode-cua-broker-"));
  if (process.platform === "win32") assert.ok(path.startsWith("\\\\.\\pipe\\"));
  else assert.ok(path.endsWith(".sock"));
  assert.notEqual(path, mintBrokerSocketPath());
  assert.match(randomUUID(), /^[0-9a-f-]+$/);
});
