/* eslint-disable max-lines -- Helper 进程边界的参数、预检、broker 与投影测试共享同一组 fixture。 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callBrokerMethod, mintBrokerSocketPath } from "./broker.js";
import { findOfficialCuaFrameContentPair } from "./frame-contract.js";
import { encodeRgbPng } from "./png.js";
import {
  createHelperBackend,
  createHelperBrokerServer,
  parseHelperArguments,
  preflightLinuxHelperCapabilities,
  projectProducerResult,
  readHelperPermissionStatus,
  runHelperPermissionMode,
  runHelperProcess,
  waitForHelperCredentialBootstrap,
} from "./helper-entry.js";
import { HELPER_CONTROL_PROTOCOL } from "./broker-helper-constants.js";

const context = { workspaceKey: "workspace", sessionId: "session", runtimeScope: "main" };

function mockProducer(overrides = {}) {
  const calls = [];
  return {
    calls,
    async dispatch(method, params, owner) {
      calls.push({ method, params, context: owner });
      return { action_sent: true };
    },
    async closeSession(owner) {
      calls.push({ method: "close_session", context: owner });
    },
    async dispose() {
      calls.push({ method: "dispose" });
    },
    ...overrides,
  };
}

function linuxXa11y(calls, overrides = {}) {
  return {
    App: {
      async list() {
        calls.push("App.list");
        return [];
      },
    },
    async inputSim() {
      calls.push("inputSim");
      return {
        async dispose() {
          calls.push("dispose");
        },
      };
    },
    ...overrides,
  };
}

test("Linux capability preflight allows X11 after AT-SPI and inputSim initialization", async () => {
  const calls = [];
  await preflightLinuxHelperCapabilities({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
    xa11y: linuxXa11y(calls),
    async accessFile() {
      calls.push("uinput");
    },
  });
  assert.deepEqual(calls, ["App.list", "inputSim", "dispose"]);
});

test("Linux capability preflight accepts the xa11y 0.15 InputSim lifecycle", async () => {
  const calls = [];
  await preflightLinuxHelperCapabilities({
    platform: "linux",
    env: { DISPLAY: ":0" },
    xa11y: linuxXa11y(calls, {
      async inputSim() {
        calls.push("inputSim");
        return { click() {} };
      },
    }),
  });
  assert.deepEqual(calls, ["App.list", "inputSim"]);
});

test("Linux capability preflight rejects Wayland before native probes when uinput is denied", async () => {
  const calls = [];
  await assert.rejects(
    preflightLinuxHelperCapabilities({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
      xa11y: linuxXa11y(calls),
      async accessFile(path, mode) {
        calls.push({ path, mode });
        throw new Error("EACCES");
      },
    }),
    (error) =>
      error?.code === "broker_unavailable" &&
      error.message === "Linux Wayland Computer Use requires writable /dev/uinput.",
  );
  assert.deepEqual(calls, [{ path: "/dev/uinput", mode: 2 }]);
});

test("Linux capability preflight allows Wayland only after same-process uinput access", async () => {
  const calls = [];
  await preflightLinuxHelperCapabilities({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    xa11y: linuxXa11y(calls),
    async accessFile(path, mode) {
      calls.push(`access:${path}:${mode}`);
    },
  });
  assert.deepEqual(calls, ["access:/dev/uinput:2", "App.list", "inputSim", "dispose"]);
});

test("Linux capability preflight rejects a headless session with a stable reason", async () => {
  const calls = [];
  await assert.rejects(
    preflightLinuxHelperCapabilities({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland" },
      xa11y: linuxXa11y(calls),
    }),
    (error) =>
      error?.code === "broker_unavailable" &&
      error.message === "Linux Computer Use Helper requires an X11 or Wayland display session.",
  );
  assert.deepEqual(calls, []);
});

test("Linux capability preflight fails closed for AT-SPI and inputSim failures", async (t) => {
  await t.test("AT-SPI failure", async () => {
    const calls = [];
    const xa11y = linuxXa11y(calls);
    xa11y.App.list = async () => {
      calls.push("App.list");
      return { invalid: true };
    };
    await assert.rejects(
      preflightLinuxHelperCapabilities({
        platform: "linux",
        env: { DISPLAY: ":0" },
        xa11y,
      }),
      (error) =>
        error?.code === "broker_unavailable" &&
        error.message === "Linux Computer Use Helper AT-SPI capability is unavailable.",
    );
    assert.deepEqual(calls, ["App.list"]);
  });

  await t.test("inputSim failure", async () => {
    const calls = [];
    const xa11y = linuxXa11y(calls, {
      async inputSim() {
        calls.push("inputSim");
        throw new Error("native initialization failed");
      },
    });
    await assert.rejects(
      preflightLinuxHelperCapabilities({
        platform: "linux",
        env: { DISPLAY: ":0" },
        xa11y,
      }),
      (error) =>
        error?.code === "broker_unavailable" &&
        error.message === "Linux Computer Use Helper input simulation capability is unavailable.",
    );
    assert.deepEqual(calls, ["App.list", "inputSim"]);
  });

  await t.test("inputSim dispose failure", async () => {
    const calls = [];
    const xa11y = linuxXa11y(calls, {
      async inputSim() {
        calls.push("inputSim");
        return {
          async dispose() {
            calls.push("dispose");
            throw new Error("native disposal failed");
          },
        };
      },
    });
    await assert.rejects(
      preflightLinuxHelperCapabilities({
        platform: "linux",
        env: { DISPLAY: ":0" },
        xa11y,
      }),
      (error) =>
        error?.code === "broker_unavailable" &&
        error.message === "Linux Computer Use Helper input simulation capability is unavailable.",
    );
    assert.deepEqual(calls, ["App.list", "inputSim", "dispose"]);
  });
});

test("Linux capability preflight is a no-op on other platforms", async () => {
  const calls = [];
  await preflightLinuxHelperCapabilities({
    platform: "win32",
    env: {},
    xa11y: linuxXa11y(calls),
    async accessFile() {
      calls.push("uinput");
    },
  });
  assert.deepEqual(calls, []);
});

test("Linux process startup completes capability preflight before opening its transport", async () => {
  const calls = [];
  const producer = mockProducer();
  await assert.rejects(
    runHelperProcess({
      args: { socketPath: "must-not-open" },
      platform: "linux",
      env: {},
      xa11y: linuxXa11y(calls),
      producer,
    }),
    (error) =>
      error?.code === "broker_unavailable" &&
      error.message === "Linux Computer Use Helper requires an X11 or Wayland display session.",
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(producer.calls, []);
});

test("helper arguments keep credentials off argv and require managed PiP", () => {
  assert.deepEqual(
    parseHelperArguments([
      "--socket",
      "pipe",
      "--parent-pid",
      "42",
      "--pip-socket",
      "pip-presentation",
      "--pip-mode",
      "enabled",
    ]),
    {
      socketPath: "pipe",
      pipSocketPath: "pip-presentation",
      parentPid: 42,
      pipMode: "enabled",
    },
  );
  assert.deepEqual(parseHelperArguments(["--socket", "pipe"]), { socketPath: "pipe" });
  assert.throws(
    () => parseHelperArguments(["--socket", "pipe", "--capability", "secret"]),
    /invalid/u,
  );
  assert.throws(
    () => parseHelperArguments(["--socket", "pipe", "--socket", "other", "--parent-pid", "1"]),
    /invalid/u,
  );
  assert.throws(
    () => parseHelperArguments(["--socket", "pipe", "--parent-pid", "1", "--pip-mode", "enabled"]),
    /PiP socket/u,
  );
});

test("helper arguments retain path aliases but reject retired credential and allow flags", () => {
  assert.deepEqual(
    parseHelperArguments([
      "--broker-socket",
      "/tmp/cua.sock",
      "--launcher-pid",
      "42",
      "--pip-socket",
      "/tmp/cua.pip.sock",
      "--exit-log",
      "/tmp/cua.exit.log",
      "--pip-mode",
      "enabled",
    ]),
    {
      socketPath: "/tmp/cua.sock",
      pipSocketPath: "/tmp/cua.pip.sock",
      parentPid: 42,
      exitLogPath: "/tmp/cua.exit.log",
      pipMode: "enabled",
    },
  );
  assert.throws(
    () => parseHelperArguments(["--socket", "/tmp/a.sock", "--broker-socket", "/tmp/b.sock"]),
    /invalid/u,
  );
  for (const flag of [
    "--capability",
    "--generation",
    "--allow-unsigned-launcher-local-dev",
    "--allow-external-broker-client-local-dev",
  ]) {
    const argv = ["--socket", "/tmp/a.sock", flag];
    if (flag === "--capability") argv.push("secret");
    if (flag === "--generation") argv.push("0");
    assert.throws(() => parseHelperArguments(argv), /invalid/u);
  }
});

test("helper credential bootstrap challenges its exact parent IPC channel once", async () => {
  const channel = new EventEmitter();
  channel.connected = true;
  const sent = [];
  channel.send = (message, callback) => {
    sent.push(message);
    queueMicrotask(() => {
      channel.emit("message", {
        protocol: HELPER_CONTROL_PROTOCOL,
        type: "bootstrap_credentials",
        pid: message.pid,
        nonce: message.nonce,
        capability: "secret",
        generation: 7,
      });
      callback?.();
    });
    return true;
  };

  assert.deepEqual(
    await waitForHelperCredentialBootstrap({ channel, pid: 42, nonce: "challenge" }),
    { capability: "secret", generation: 7 },
  );
  assert.deepEqual(sent, [
    {
      protocol: HELPER_CONTROL_PROTOCOL,
      type: "bootstrap_request",
      pid: 42,
      nonce: "challenge",
    },
  ]);
  assert.equal(channel.listenerCount("message"), 0);
});

test("helper credential bootstrap fails closed on mismatch and timeout", async () => {
  const mismatched = new EventEmitter();
  mismatched.connected = true;
  mismatched.send = (message) => {
    queueMicrotask(() =>
      mismatched.emit("message", {
        protocol: HELPER_CONTROL_PROTOCOL,
        type: "bootstrap_credentials",
        pid: message.pid,
        nonce: "wrong",
        capability: "secret",
        generation: 0,
      }),
    );
    return true;
  };
  await assert.rejects(
    waitForHelperCredentialBootstrap({ channel: mismatched, pid: 42, nonce: "challenge" }),
    (error) => error?.code === "invalid_request",
  );

  const silent = new EventEmitter();
  silent.connected = true;
  silent.send = () => true;
  await assert.rejects(
    waitForHelperCredentialBootstrap({ channel: silent, pid: 42, timeoutMs: 5 }),
    (error) => error?.code === "broker_unavailable",
  );
});

test("permission mode bypasses bootstrap while managed mode bootstraps before native load", async () => {
  let waited = false;
  let loaded = false;
  const permissionResult = await runHelperProcess({
    args: {
      socketPath: "permission-only",
      parentPid: 42,
      permissionRequest: "accessibility",
    },
    loadXa11y: async () => {
      loaded = true;
      return {
        App: { list: async () => [] },
        screenshot: async () => {
          throw new Error("not called");
        },
      };
    },
    waitForCredentialBootstrap: async () => {
      waited = true;
      throw new Error("must not run");
    },
    logExit: async () => {},
  });
  assert.equal(loaded, true);
  assert.equal(waited, false);
  assert.equal(permissionResult.state, "granted");

  loaded = false;
  await assert.rejects(
    runHelperProcess({
      args: { socketPath: "managed", parentPid: 42 },
      loadXa11y: async () => {
        loaded = true;
        return linuxXa11y([]);
      },
      waitForCredentialBootstrap: async () => {
        throw new Error("bootstrap denied");
      },
    }),
    /bootstrap denied/u,
  );
  assert.equal(loaded, false);
});

test("permission mode performs a real xa11y probe and records a fail-closed result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-cua-helper-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "permission.exit.log");
  const args = parseHelperArguments([
    "--broker-socket",
    join(directory, "broker.sock"),
    "--permission-request",
    "accessibility",
    "--exit-log",
    logPath,
  ]);
  const rows = [];
  const result = await runHelperPermissionMode({
    args,
    xa11y: {
      App: {
        async list() {
          throw new Error("TCC denied");
        },
      },
      async screenshot() {
        throw new Error("not called");
      },
    },
    async logExit(event, details) {
      rows.push({ event, ...details });
    },
  });
  assert.deepEqual(result, {
    capability: "accessibility",
    state: "denied",
    error: "TCC denied",
  });
  assert.deepEqual(rows, [
    {
      event: "permission_request",
      capability: "accessibility",
      state: "denied",
      error: "TCC denied",
    },
  ]);
  await assert.rejects(readFile(logPath), { code: "ENOENT" });
});

test("permission status reports independent accessibility and screen probes", async () => {
  const status = await readHelperPermissionStatus({
    App: {
      async list() {
        return [];
      },
    },
    async screenshot() {
      throw new Error("screen denied");
    },
  });
  assert.equal(status.grant_owner, "dev.zcode.cua-helper");
  assert.equal(status.accessibility, "granted");
  assert.equal(status.screen_recording, "denied");
  assert.deepEqual(status.screen_capture_probe, { ok: false, reason: "screen denied" });
});

test("permission probes reject malformed native results instead of reporting granted", async () => {
  const status = await readHelperPermissionStatus({
    App: { async list() {} },
    async screenshot() {
      return { width: 1, height: 1, toPng: () => Buffer.alloc(0) };
    },
  });
  assert.equal(status.accessibility, "denied");
  assert.equal(status.screen_recording, "denied");
  assert.match(status.screen_capture_probe.reason, /invalid screenshot/u);
});

test("only an authorized mutation refreshes Helper activity", async () => {
  let activityCount = 0;
  const backend = createHelperBackend({
    capability: "secret",
    generation: 3,
    producer: mockProducer(),
    onActivity() {
      activityCount += 1;
    },
  });
  assert.equal(backend.authorize({ capability: "wrong", generation: 3 }), false);
  assert.equal(activityCount, 0);
  assert.equal(backend.authorize({ capability: "secret", generation: 3 }), true);
  assert.equal(activityCount, 1);
  await backend.dispose();
  assert.equal(backend.authorize({ capability: "secret", generation: 3 }), false);
  assert.equal(activityCount, 1);
});

test("producer screenshot projects to structured state and an official frame pair", () => {
  const result = projectProducerResult("get_app_state", {
    state_id: "state-1",
    mode: "full",
    base_state_id: null,
    app: { pid: 42, name: "Editor", bundle_id: null, active: true },
    window: { window_id: 5 },
    elements: [],
    text: "window Editor",
    frame_id: "frame-1",
    screenshot: {
      data: Buffer.from("png").toString("base64"),
      mime_type: "image/png",
      width: 640,
      height: 480,
      frame_id: "frame-1",
    },
  });
  assert.ok(findOfficialCuaFrameContentPair(result.content));
  const frameRef = JSON.parse(result.content[1].text);
  assert.deepEqual(frameRef.appRef, { pid: 42, window_id: 5 });
  assert.equal(result.structuredContent.snapshot_mode, "full");
  assert.equal(Object.hasOwn(result.structuredContent, "screenshot"), false);
  assert.deepEqual(result._meta["zcode.cua/app-associations-v1"].primary, {
    appKey: "pid:42",
    displayName: "Editor",
  });
});

test("helper broker authenticates mutations while keeping read-only status compatible", async () => {
  const producer = mockProducer({
    async dispatch(method, params, owner) {
      this.calls.push({ method, params, context: owner });
      return [{ pid: 42, name: "Editor", bundle_id: null, active: true }];
    },
  });
  const backend = createHelperBackend({ capability: "secret", generation: 3, producer });
  const socketPath = mintBrokerSocketPath();
  const server = await createHelperBrokerServer({ socketPath, backend });
  try {
    const status = await callBrokerMethod({ socketPath, method: "permission_status", params: {} });
    assert.equal(status.available, true);

    await assert.rejects(
      callBrokerMethod({
        socketPath,
        capability: "wrong",
        generation: 3,
        method: "execute",
        params: { method: "list_apps", input: {}, context },
      }),
      (error) => error?.code === "not_authorized",
    );
    assert.equal(producer.calls.length, 0);

    const result = await callBrokerMethod({
      socketPath,
      capability: "secret",
      generation: 3,
      method: "execute",
      params: { method: "list_apps", input: {}, context },
    });
    assert.deepEqual(JSON.parse(result.content[0].text), [
      { pid: 42, name: "Editor", bundle_id: null, active: true },
    ]);
    assert.equal(producer.calls.length, 1);
  } finally {
    await server.close();
    await backend.dispose();
  }
});

test("helper backend serializes producer work and closes one session without global disposal", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];
  const producer = mockProducer({
    async dispatch(_method, params) {
      order.push(`start:${params.id}`);
      if (params.id === 1) await first;
      order.push(`end:${params.id}`);
      return { action_sent: true };
    },
  });
  const backend = createHelperBackend({ capability: "secret", generation: 0, producer });
  const request = (id) => backend.execute({ method: "key", input: { id }, context });
  const one = request(1);
  const two = request(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:1"]);
  releaseFirst();
  await Promise.all([one, two]);
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
  await backend.close_session({ context });
  assert.equal(producer.calls.at(-1).method, "close_session");
  await backend.dispose();
  assert.equal(producer.calls.at(-1).method, "dispose");
});

test("helper backend binds only an explicit trusted get_app_state screenshot to its turn", async () => {
  const screenshot = {
    data: encodeRgbPng(2, 1, Buffer.alloc(6)).toString("base64"),
    mime_type: "image/png",
    width: 2,
    height: 1,
    frame_id: "frame-1",
  };
  const producer = mockProducer({
    async dispatch() {
      return {
        state_id: "state-1",
        frame_id: "frame-1",
        app: { pid: 42, name: "Editor" },
        screenshot,
      };
    },
  });
  const captures = [];
  const backend = createHelperBackend({
    capability: "secret",
    generation: 0,
    producer,
    onTrustedCapture: async (capture) => captures.push(capture),
  });
  await backend.execute({
    method: "get_app_state",
    input: { include_screenshot: true },
    context: { ...context, turnId: "turn-1" },
  });
  assert.deepEqual(captures, [
    {
      sessionId: "session",
      turnId: "turn-1",
      frameId: "frame-1",
      mimeType: "image/png",
      data: screenshot.data,
      width: 2,
      height: 1,
      title: "Editor",
    },
  ]);
  await backend.execute({
    method: "get_app_state",
    input: { include_screenshot: false },
    context: { ...context, turnId: "turn-1" },
  });
  await backend.execute({
    method: "get_app_state",
    input: { include_screenshot: true },
    context,
  });
  assert.equal(captures.length, 1);
});

test("helper backend keeps broker observations successful when PiP cleanup also fails", async () => {
  const screenshot = {
    data: encodeRgbPng(2, 1, Buffer.alloc(6)).toString("base64"),
    mime_type: "image/png",
    width: 2,
    height: 1,
    frame_id: "frame-1",
  };
  const backend = createHelperBackend({
    capability: "secret",
    generation: 0,
    producer: mockProducer({
      async dispatch() {
        return { frame_id: "frame-1", screenshot };
      },
    }),
    onTrustedCapture: async () => {
      throw new Error("presenter failed");
    },
    onPipError: async () => {
      throw new Error("cleanup failed");
    },
  });

  await assert.doesNotReject(
    backend.execute({
      method: "get_app_state",
      input: { include_screenshot: true },
      context: { ...context, turnId: "turn-1" },
    }),
  );
});

test("helper backend omits a title outside the native presenter UTF-8 contract", async () => {
  const screenshot = {
    data: encodeRgbPng(2, 1, Buffer.alloc(6)).toString("base64"),
    mime_type: "image/png",
    width: 2,
    height: 1,
    frame_id: "frame-1",
  };
  const captures = [];
  const backend = createHelperBackend({
    capability: "secret",
    generation: 0,
    producer: mockProducer({
      async dispatch() {
        return {
          frame_id: "frame-1",
          app: { name: "界".repeat(86) },
          screenshot,
        };
      },
    }),
    onTrustedCapture: async (capture) => captures.push(capture),
  });

  await backend.execute({
    method: "get_app_state",
    input: { include_screenshot: true },
    context: { ...context, turnId: "turn-1" },
  });
  assert.equal(captures.length, 1);
  assert.equal("title" in captures[0], false);
});
