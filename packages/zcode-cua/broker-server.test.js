/* oxlint-disable eslint(max-lines) -- Public broker/server compatibility behavior is exercised as one matrix. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  buildHelperOpenArgs,
  buildHelperProcessArgs,
  clearCuaProductHelperAgentEnvUnavailable,
  createAxReadOnlyMethods,
  createCuaHelperInstaller,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  cuaBrokerRefreshMarkerPath,
  hasCuaProductHelperAgentEnvUnavailable,
  isCuaLocalDevelopmentRuntime,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  loadRealNativeAddon,
  markCuaProductHelperAgentEnvUnavailable,
  publishCuaBrokerRefreshMarker,
  queryHelperScreenRecordingPreflightViaLaunchServices,
  reapOrphanedHelpers,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
  resolveHelperPermissionSubjectIdentity,
  roleToKind,
  waitForCuaHelperStartup,
} from "./broker-server.js";
import { CuaHelperError } from "./broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_BUNDLE_ID,
  HELPER_CONTROL_PROTOCOL,
} from "./broker-helper-constants.js";

const createTemporaryDirectory = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-cua-server-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("buildHelperOpenArgs emits one deterministic LaunchServices argument contract", () => {
  assert.deepEqual(
    buildHelperOpenArgs(
      {
        appPath: "/Applications/ZCode Computer Use.app",
        socketPath: "/tmp/cua.sock",
        pipSocketPath: "/tmp/cua.pip.sock",
        exitLogPath: "/tmp/cua.exit.log",
        pipMode: "enabled",
      },
      42,
    ),
    [
      "-n",
      "/Applications/ZCode Computer Use.app",
      "--args",
      "--socket",
      "/tmp/cua.sock",
      "--pip-socket",
      "/tmp/cua.pip.sock",
      "--parent-pid",
      "42",
      "--exit-log",
      "/tmp/cua.exit.log",
      "--pip-mode",
      "enabled",
    ],
  );
  assert.deepEqual(
    buildHelperProcessArgs(
      {
        socketPath: "/tmp/cua.sock",
        pipSocketPath: "/tmp/cua.pip.sock",
        exitLogPath: "/tmp/cua.exit.log",
        pipMode: "enabled",
      },
      42,
    ),
    [
      "--socket",
      "/tmp/cua.sock",
      "--pip-socket",
      "/tmp/cua.pip.sock",
      "--parent-pid",
      "42",
      "--exit-log",
      "/tmp/cua.exit.log",
      "--pip-mode",
      "enabled",
    ],
  );
  assert.throws(
    () => buildHelperOpenArgs({ appPath: "app", socketPath: "socket" }, 0),
    /launcherPid/u,
  );
});

test("disabled PiP omits its socket from launch arguments and transport handles", async (t) => {
  const root = await createTemporaryDirectory(t);
  const socketPath = join(root, "broker.sock");
  const ignoredPipSocketPath = join(root, "must-not-exist.pip.sock");
  let launchArgs;
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    socketPath,
    pipSocketPath: ignoredPipSocketPath,
    pipMode: "disabled",
    pluginAuthority: "authority",
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    launchApplication: async ({ args, credential }) => {
      launchArgs = args;
      assert.deepEqual(credential, { capability: "authority", generation: 0 });
      return { bundleId: HELPER_BUNDLE_ID, pid: 123 };
    },
    healthProbe: async () => ({ bundleId: HELPER_BUNDLE_ID, pid: 123 }),
    callBrokerMethod: async () => ({ stopped: true }),
    waitForProcessExit: async () => true,
  });

  assert.deepEqual(host.reservedTransport, {
    socketPath,
    pluginAuthority: "authority",
    generation: 0,
  });
  const handle = await host.start();
  assert.equal(launchArgs.includes("--pip-socket"), false);
  assert.equal(Object.hasOwn(handle, "pipSocketPath"), false);
  assert.deepEqual(await host.waitForTransport(), {
    socketPath,
    pluginAuthority: "authority",
    generation: 0,
  });
  assert.equal(host.pipSocketPath, null);
  await host.stop();
});

test("macOS product launcher spawns the verified executable and answers its IPC challenge", async (t) => {
  const root = await createTemporaryDirectory(t);
  const socketPath = join(root, "broker.sock");
  const child = new EventEmitter();
  child.pid = 808;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = { resume() {} };
  let disconnected = false;
  child.disconnect = () => {
    disconnected = true;
  };
  child.unref = () => {};
  child.kill = () => true;
  let credentials;
  child.send = (message, callback) => {
    credentials = message;
    callback?.();
    return true;
  };
  let spawnCall;
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: {
      ZCODE_RUNTIME_ENV: "production",
      ZCODE_CUA_PLUGIN_AUTHORITY: "must-not-leak",
      ZCODE_CUA_PERMISSION_BROKER_CAPABILITY: "must-not-leak",
      ZCODE_CUA_PERMISSION_BROKER_GENERATION: "4",
    },
    socketPath,
    pluginAuthority: "authority",
    generation: 4,
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    resolveIdentity: async () => ({
      appPath: "/Applications/CUA.app",
      executablePath: "/Applications/CUA.app/Contents/MacOS/CUA",
      displayName: "CUA",
      bundleId: HELPER_BUNDLE_ID,
    }),
    spawnProcess: (executable, args, options) => {
      spawnCall = { executable, args, options };
      queueMicrotask(() =>
        child.emit("message", {
          protocol: HELPER_CONTROL_PROTOCOL,
          type: "bootstrap_request",
          pid: child.pid,
          nonce: "challenge",
        }),
      );
      return child;
    },
    healthProbe: async () => {
      assert.equal(disconnected, false);
      return { bundleId: HELPER_BUNDLE_ID, pid: child.pid };
    },
    callBrokerMethod: async () => ({ stopped: true }),
    waitForProcessExit: async () => true,
  });

  await host.start();
  assert.equal(disconnected, true);
  assert.equal(spawnCall.executable, "/Applications/CUA.app/Contents/MacOS/CUA");
  assert.deepEqual(spawnCall.options.stdio, ["ignore", "ignore", "pipe", "ipc"]);
  assert.equal(spawnCall.args.includes("--capability"), false);
  assert.equal(spawnCall.options.env.ZCODE_CUA_PLUGIN_AUTHORITY, undefined);
  assert.deepEqual(credentials, {
    protocol: HELPER_CONTROL_PROTOCOL,
    type: "bootstrap_credentials",
    pid: child.pid,
    nonce: "challenge",
    capability: "authority",
    generation: 4,
  });
  await host.stop();
});

test("macOS product host rejects a health identity from another process", async (t) => {
  const root = await createTemporaryDirectory(t);
  let terminated = false;
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    socketPath: join(root, "broker.sock"),
    pluginAuthority: "authority",
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    launchApplication: async () => ({
      bundleId: HELPER_BUNDLE_ID,
      pid: 808,
      terminate: async () => {
        terminated = true;
      },
    }),
    healthProbe: async () => ({ bundleId: HELPER_BUNDLE_ID, pid: 809 }),
  });

  await assert.rejects(host.start(), (error) => error?.code === "invalid_response");
  assert.equal(terminated, true);
});

test("local development requires both the compile/runtime gates", () => {
  assert.equal(
    isCuaLocalDevelopmentRuntime({ NODE_ENV: "development", ZCODE_RUNTIME_ENV: "development" }),
    true,
  );
  assert.equal(
    isCuaLocalDevelopmentRuntime({ NODE_ENV: "development", ZCODE_RUNTIME_ENV: "production" }),
    false,
  );
  assert.equal(isCuaLocalDevelopmentRuntime({ ZCODE_RUNTIME_ENV: "development" }, false), false);
});

test("permission identity is derived from a verified bundle executable", async () => {
  const appPath = "/Applications/ZCode Computer Use.app";
  const values = new Map([
    ["CFBundleExecutable", "ZCode Computer Use"],
    ["CFBundleIdentifier", HELPER_BUNDLE_ID],
    ["CFBundleDisplayName", "Computer Use"],
    ["CFBundleShortVersionString", "1.2.3"],
    ["CFBundleVersion", "45"],
  ]);
  const identity = await resolveHelperPermissionSubjectIdentity(appPath, {
    platform: "darwin",
    dependencies: {
      realpath: async (path) => path,
      stat: async (path) => ({
        isDirectory: () => path === appPath,
        isFile: () => path !== appPath,
      }),
      readPlistValue: async (_path, key) => {
        if (!values.has(key)) throw new Error("missing");
        return values.get(key);
      },
    },
  });
  assert.deepEqual(identity, {
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", "ZCode Computer Use"),
    displayName: "Computer Use",
    bundleId: HELPER_BUNDLE_ID,
    version: "1.2.3",
    buildVersion: "45",
  });
  values.set("CFBundleExecutable", "../escape");
  await assert.rejects(
    resolveHelperPermissionSubjectIdentity(appPath, {
      platform: "darwin",
      dependencies: {
        realpath: async (path) => path,
        stat: async () => ({ isDirectory: () => true, isFile: () => true }),
        readPlistValue: async (_path, key) => values.get(key),
      },
    }),
    /unsafe/u,
  );
});

test("installer verifies source, staged copy, and final bundle before returning", async (t) => {
  const root = await createTemporaryDirectory(t);
  const sourcePath = join(root, "Bundled.app");
  const installPath = join(root, "installed", "ZCode Computer Use.app");
  await mkdir(sourcePath, { recursive: true });
  const calls = [];
  const installer = createCuaHelperInstaller({
    env: { ZCODE_RUNTIME_ENV: "production", NODE_ENV: "production" },
    platform: "darwin",
    arch: "x64",
    installRoot: root,
    installPath,
    bundledAppPath: sourcePath,
    dependencies: {
      resolveIdentity: async (appPath) => ({
        appPath,
        executablePath: join(appPath, "Contents", "MacOS", "helper"),
        displayName: "Computer Use",
        bundleId: HELPER_BUNDLE_ID,
      }),
      readExecutableArchs: async () => ["x86_64"],
      verifyCodeSignature: async (path) => calls.push(["signature", path]),
      verifyTeamIdentifier: async (path) => {
        calls.push(["team", path]);
        return "TEAM";
      },
      verifyGatekeeper: async (path) => calls.push(["gatekeeper", path]),
      copyBundle: (source, destination) => cp(source, destination, { recursive: true }),
    },
  });
  assert.equal(await installer.ensureInstalled(), installPath);
  assert.equal(calls.filter(([kind]) => kind === "signature").length, 3);
  calls.length = 0;
  assert.equal(await installer.ensureInstalled(), installPath);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["signature", "team", "gatekeeper", "signature", "team", "gatekeeper"],
  );
});

test("installer upgrades changed builds and restores the old bundle after final verification fails", async (t) => {
  const root = await createTemporaryDirectory(t);
  const sourcePath = join(root, "Bundled.app");
  const installPath = join(root, "installed", "ZCode Computer Use.app");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(installPath, { recursive: true });
  await writeFile(join(sourcePath, "build.txt"), "2", "utf8");
  await writeFile(join(installPath, "build.txt"), "1", "utf8");
  let rejectFinalBundle = false;
  const installer = createCuaHelperInstaller({
    env: { ZCODE_RUNTIME_ENV: "production", NODE_ENV: "production" },
    platform: "darwin",
    arch: "arm64",
    installRoot: root,
    installPath,
    bundledAppPath: sourcePath,
    dependencies: {
      resolveIdentity: async (appPath) => ({
        appPath,
        executablePath: join(appPath, "helper"),
        displayName: "Computer Use",
        bundleId: HELPER_BUNDLE_ID,
        buildVersion: (await readFile(join(appPath, "build.txt"), "utf8")).trim(),
      }),
      readExecutableArchs: async () => ["arm64"],
      verifyCodeSignature: async (appPath) => {
        if (
          rejectFinalBundle &&
          appPath === installPath &&
          (await readFile(join(appPath, "build.txt"), "utf8")).trim() === "3"
        ) {
          throw new Error("final signature rejected");
        }
      },
      verifyTeamIdentifier: async () => "TEAM",
      verifyGatekeeper: async () => {},
      copyBundle: (source, destination) => cp(source, destination, { recursive: true }),
    },
  });

  assert.equal(await installer.ensureInstalled(), installPath);
  assert.equal(await readFile(join(installPath, "build.txt"), "utf8"), "2");

  await writeFile(join(sourcePath, "build.txt"), "3", "utf8");
  rejectFinalBundle = true;
  await assert.rejects(installer.ensureInstalled(), /installation failed/u);
  assert.equal(await readFile(join(installPath, "build.txt"), "utf8"), "2");
});

test("unsigned Helper escape is limited to local development", async (t) => {
  const root = await createTemporaryDirectory(t);
  const sourcePath = join(root, "Bundled.app");
  await mkdir(sourcePath, { recursive: true });
  const installer = createCuaHelperInstaller({
    env: {
      NODE_ENV: "development",
      ZCODE_RUNTIME_ENV: "development",
      ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "on",
    },
    platform: "darwin",
    arch: "arm64",
    installRoot: root,
    bundledAppPath: sourcePath,
    dependencies: {
      resolveIdentity: async (appPath) => ({
        appPath,
        executablePath: "helper",
        displayName: "Computer Use Dev",
        bundleId: DEV_CUA_HELPER_BUNDLE_ID,
      }),
      readExecutableArchs: async () => ["aarch64"],
      verifyCodeSignature: async () => assert.fail("signature must be skipped only in local dev"),
      verifyTeamIdentifier: async () => assert.fail("team must be skipped only in local dev"),
      copyBundle: (source, destination) => cp(source, destination, { recursive: true }),
    },
  });
  assert.match(await installer.ensureInstalled(), /[\\/]dev[\\/]ZCode Computer Use Dev\.app$/u);
});

test("refresh markers are atomic, private, disposable, and absent for named pipes", async (t) => {
  const root = await createTemporaryDirectory(t);
  const socketPath = join(root, "broker.sock");
  assert.equal(cuaBrokerRefreshMarkerPath("\\\\.\\pipe\\cua"), undefined);
  const handle = await publishCuaBrokerRefreshMarker(socketPath, {
    now: () => 100,
    deadlineMs: 25,
  });
  assert.equal(handle.path, `${socketPath}.refresh.json`);
  assert.deepEqual(JSON.parse(await readFile(handle.path, "utf8")), {
    schema: 1,
    pid: process.pid,
    createdAt: 100,
    expiresAt: 125,
  });
  await handle.dispose();
  await assert.rejects(readFile(handle.path, "utf8"), /ENOENT/u);
});

test("native loader uses the injected require seam and fails closed", () => {
  const loaded = { App: {} };
  assert.equal(
    loadRealNativeAddon({ modulePath: import.meta.filename, require: () => loaded }),
    loaded,
  );
  assert.throws(
    () => loadRealNativeAddon({ modulePath: join(tmpdir(), "definitely-missing.node") }),
    /not found/u,
  );
});

test("AX read-only adapter maps roles and records only real observations", async () => {
  assert.equal(roleToKind("AXButton"), "button");
  assert.equal(roleToKind("UIA_TextControlTypeId"), "text_input");
  assert.equal(roleToKind("made-up-role"), undefined);
  const snapshots = [];
  const methods = createAxReadOnlyMethods(
    {
      async getAppState(input) {
        return { input, elements: [{ role: "AXCheckBox" }, { role: "AXUnknown" }] };
      },
    },
    { recordSnapshot: async (value) => snapshots.push(value) },
  );
  const result = await methods.get_app_state({ app_ref: { pid: 1 } }, { sessionId: "s" });
  assert.equal(result.elements[0].kind, "checkbox");
  assert.equal("kind" in result.elements[1], false);
  assert.equal(snapshots.length, 1);
  await assert.rejects(methods.list_apps({}, {}), /unavailable/u);
});

test("lifecycle manager single-flights creation, retains one owner, and fences dispose", async () => {
  const disposed = [];
  const manager = new CuaHelperLifecycleManager(async (managed) => disposed.push(managed.id));
  let creates = 0;
  const create = async () => {
    creates += 1;
    await Promise.resolve();
    return { id: creates };
  };
  const [first, second] = await Promise.all([
    manager.acquire({ create }),
    manager.acquire({ create }),
  ]);
  assert.equal(first, second);
  assert.equal(creates, 1);
  assert.equal(await manager.acquire({ isAdmitted: () => false, create }), undefined);
  assert.equal(manager.peek(), first);
  await manager.dispose();
  assert.equal(manager.disposed, true);
  assert.equal(manager.peek(), undefined);
  assert.deepEqual(disposed, [1]);
  assert.equal(await manager.acquire({ create }), undefined);
});

test("workspace registry keys by identity with path fallback", () => {
  const registry = new CuaProductHelperWorkspaceRegistry();
  registry.setEnabled({ workspacePath: "C:/one", workspaceIdentity: " remote:1 " }, true);
  assert.equal(
    registry.isEnabled({ workspacePath: "C:/other", workspaceIdentity: "remote:1" }),
    true,
  );
  registry.setEnabled({ workspaceIdentity: "remote:1" }, false);
  assert.equal(registry.size, 0);
  registry.setEnabled({ workspacePath: "C:/one" }, true);
  assert.equal(registry.delete({ workspacePath: "C:/one" }), true);
});

test("macOS product host owns one launch, permission queries, and transport-preserving restart", async (t) => {
  const root = await createTemporaryDirectory(t);
  const socketPath = join(root, "broker.sock");
  const pipSocketPath = join(root, "broker.pip.sock");
  let launches = 0;
  const brokerCalls = [];
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: {
      ZCODE_RUNTIME_ENV: "production",
      ZCODE_CUA_PLUGIN_AUTHORITY: "must-not-leak",
      ZCODE_CUA_PERMISSION_BROKER_CAPABILITY: "must-not-leak",
      ZCODE_CUA_PERMISSION_BROKER_GENERATION: "9",
    },
    socketPath,
    pipSocketPath,
    pluginAuthority: "authority",
    generation: 7,
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    launchApplication: async ({ args, credential, env }) => {
      launches += 1;
      assert.equal(args.includes("--capability"), false);
      assert.equal(args.includes("--generation"), false);
      assert.equal(args.includes("--allow-unsigned-launcher-local-dev"), false);
      assert.deepEqual(credential, { capability: "authority", generation: 7 });
      assert.equal(env.ZCODE_CUA_PLUGIN_AUTHORITY, undefined);
      assert.equal(env.ZCODE_CUA_PERMISSION_BROKER_CAPABILITY, undefined);
      assert.equal(env.ZCODE_CUA_PERMISSION_BROKER_GENERATION, undefined);
      return { bundleId: HELPER_BUNDLE_ID, pid: 123 };
    },
    healthProbe: async (_path, options) => {
      assert.equal(options.capability, "authority");
      assert.equal(options.generation, 7);
      return { bundleId: HELPER_BUNDLE_ID, pid: 123 };
    },
    callBrokerMethod: async (request) => {
      brokerCalls.push(request);
      if (request.method === "permission_status") {
        return {
          grant_owner: HELPER_BUNDLE_ID,
          accessibility: "granted",
          screen_recording: "granted",
          screen_capture_probe: { ok: true, classification: "functional" },
        };
      }
      return { stopped: true };
    },
  });
  const [first, second] = await Promise.all([host.start(), host.start()]);
  assert.equal(first, second);
  assert.equal(launches, 1);
  assert.deepEqual(host.reservedTransport, {
    socketPath,
    pipSocketPath,
    pluginAuthority: "authority",
    generation: 7,
  });
  assert.equal((await host.queryPermissionStatus()).accessibility, "granted");
  assert.equal((await host.queryScreenCaptureProbe()).ok, true);
  const restarted = await host.restartAfterCurrentStartPreservingTransport();
  assert.equal(restarted.reused, true);
  assert.equal(restarted.handle.socketPath, socketPath);
  assert.equal(launches, 2);
  assert.ok(brokerCalls.some((call) => call.method === "shutdown"));
  await host.stop();
});

test("transport-preserving restart waits for the old Helper exit before reusing sockets", async (t) => {
  const root = await createTemporaryDirectory(t);
  let allowExit;
  const exitGate = new Promise((resolve) => {
    allowExit = resolve;
  });
  const events = [];
  let launches = 0;
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    socketPath: join(root, "broker.sock"),
    pluginAuthority: "authority",
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    launchApplication: async () => {
      launches += 1;
      events.push(`launch:${launches}`);
      return { bundleId: HELPER_BUNDLE_ID, pid: 456 };
    },
    healthProbe: async () => ({ bundleId: HELPER_BUNDLE_ID, pid: 456 }),
    callBrokerMethod: async ({ method }) => {
      events.push(method);
      return { stopped: true };
    },
    waitForProcessExit: async (pid) => {
      events.push(`wait:${pid}`);
      await exitGate;
      events.push(`exited:${pid}`);
      return true;
    },
  });
  await host.start();

  const restarting = host.restartAfterCurrentStartPreservingTransport({
    beforeFreshStart: () => events.push("before-fresh-start"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 1);
  assert.deepEqual(events, ["launch:1", "shutdown", "wait:456"]);

  allowExit();
  await restarting;
  assert.deepEqual(events.slice(0, 6), [
    "launch:1",
    "shutdown",
    "wait:456",
    "exited:456",
    "before-fresh-start",
    "launch:2",
  ]);
  await host.stop();
});

test("transport-preserving restart keeps the old handle when exit cannot be confirmed", async (t) => {
  const root = await createTemporaryDirectory(t);
  let exitChecks = 0;
  let launches = 0;
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    socketPath: join(root, "broker.sock"),
    pluginAuthority: "authority",
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    launchApplication: async () => {
      launches += 1;
      return { bundleId: HELPER_BUNDLE_ID, pid: 789 };
    },
    healthProbe: async () => ({ bundleId: HELPER_BUNDLE_ID, pid: 789 }),
    callBrokerMethod: async () => ({ stopped: true }),
    waitForProcessExit: async () => {
      exitChecks += 1;
      return exitChecks > 1;
    },
  });
  const first = await host.start();

  await assert.rejects(host.restartAfterCurrentStartPreservingTransport(), (error) => {
    assert.ok(error instanceof CuaHelperError);
    assert.equal(error.code, "helper_shutdown_unconfirmed");
    return true;
  });
  assert.equal(host.running, true);
  assert.equal(host.socketPath, first.socketPath);
  assert.equal(launches, 1);
  await host.stop();
});

test("macOS transport waits for broker health without cancelling shared startup", async (t) => {
  const root = await createTemporaryDirectory(t);
  let resolveHealth;
  const health = new Promise((resolvePromise) => {
    resolveHealth = resolvePromise;
  });
  const host = createProductCuaHelperHost({
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    socketPath: join(root, "broker.sock"),
    pluginAuthority: "authority",
    helperInstaller: { ensureInstalled: async () => "/Applications/CUA.app" },
    launchApplication: async () => ({ bundleId: HELPER_BUNDLE_ID, pid: 321 }),
    healthProbe: async () => health,
    callBrokerMethod: async () => ({ stopped: true }),
  });
  const startup = host.start();
  await assert.rejects(host.waitForTransport(5), (error) => {
    assert.ok(error instanceof CuaHelperError);
    assert.equal(error.code, "caller_timeout");
    return true;
  });
  resolveHealth({ bundleId: HELPER_BUNDLE_ID, pid: 321 });
  await startup;
  assert.deepEqual(await host.waitForTransport(), {
    socketPath: join(root, "broker.sock"),
    pipSocketPath: `${join(root, "broker.sock")}.pip`,
    pluginAuthority: "authority",
    generation: 0,
  });
  await host.stop();
});

test("MCP resolver injects credentials without mutating peers and removes CUA on failure", async () => {
  const other = { name: "filesystem", command: "fs", args: [], env: [] };
  const cua = {
    name: "computer-use",
    command: "zcode-cua",
    args: [],
    env: [{ name: "KEEP", value: "yes" }],
  };
  const handle = {
    socketPath: "/tmp/cua.sock",
    pipSocketPath: "/tmp/cua.sock.pip",
    pluginAuthority: "authority",
    generation: 9,
  };
  let starts = 0;
  const resolver = createCuaProductMcpServerResolver({
    running: false,
    socketPath: null,
    pluginAuthority: null,
    start: async () => {
      starts += 1;
      return handle;
    },
    restart: async () => handle,
  });
  const resolved = await resolver.resolveMcpServers([other, cua]);
  assert.equal(starts, 1);
  assert.equal(resolved[0], other);
  assert.deepEqual(resolved[1].env, [
    { name: "KEEP", value: "yes" },
    { name: "ZCODE_CUA_PERMISSION_BROKER_SOCKET", value: "/tmp/cua.sock" },
    { name: "ZCODE_CUA_PLUGIN_AUTHORITY", value: "authority" },
    { name: "ZCODE_CUA_PERMISSION_BROKER_GENERATION", value: "9" },
  ]);
  assert.deepEqual(cua.env, [{ name: "KEEP", value: "yes" }]);

  const failed = createCuaProductMcpServerResolver({
    running: false,
    start: async () => {
      throw new Error("no helper");
    },
    restart: async () => {
      throw new Error("no helper");
    },
  });
  assert.deepEqual(await failed.resolveMcpServers([other, cua]), [other]);
});

test("permission restart publishes the refresh marker for the pre-restart transport once", async () => {
  const handle = { socketPath: "/tmp/cua.sock", pluginAuthority: "authority" };
  const host = {
    running: true,
    socketPath: handle.socketPath,
    pluginAuthority: handle.pluginAuthority,
    start: async () => handle,
    restart: async () => handle,
    checkHealth: async () => ({ ok: true }),
    restartAfterCurrentStartPreservingTransport: async (options) => {
      host.socketPath = null;
      await options.beforeFreshStart();
      host.socketPath = handle.socketPath;
      return { handle, reused: true };
    },
  };
  const marked = [];
  const resolver = createCuaProductMcpServerResolver(host, {
    publishRefreshMarker: async (socketPath) => marked.push(socketPath),
  });
  await resolver.restartAfterPermissionGrant("onboarding-1");
  await resolver.restartAfterPermissionGrant("onboarding-1");
  assert.deepEqual(marked, [handle.socketPath]);
});

test("MCP candidate detection is broad at the security boundary without proxy false positives", () => {
  assert.equal(isPotentialZCodeCuaAgentMcpServer({ name: "computer-use" }), true);
  assert.equal(
    isPotentialZCodeCuaAgentMcpServer({ command: "uvx", args: ["zcode-cua[macos]"] }),
    true,
  );
  assert.equal(
    isPotentialZCodeCuaAgentMcpServer({
      command: "node",
      args: [],
      env: [{ name: "ZCODE_PLUGIN_ID", value: "computer-use@zcode-plugins-official" }],
    }),
    true,
  );
  assert.equal(isPotentialZCodeCuaAgentMcpServer({ command: "zcode-cua-proxy" }), false);
});

test("startup deadline rejects only the caller and leaves the shared startup intact", async () => {
  let resolveStartup;
  const startup = new Promise((resolvePromise) => {
    resolveStartup = resolvePromise;
  });
  await assert.rejects(waitForCuaHelperStartup(startup, 5), (error) => {
    assert.ok(error instanceof CuaHelperError);
    assert.equal(error.code, "caller_timeout");
    return true;
  });
  resolveStartup("ready");
  assert.equal(await startup, "ready");
});

test("workspace plugin enablement follows explicit config with workspace precedence", () => {
  const enabled = {
    plugins: { enabledPlugins: { "computer-use@zcode-plugins-official": true } },
  };
  const disabled = {
    plugins: { enabledPlugins: { "computer-use@zcode-plugins-official": false } },
  };
  assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: {}, userConfig: enabled }), true);
  assert.equal(
    isOfficialCuaPluginEnabledForWorkspace({
      env: {},
      userConfig: enabled,
      workspaceConfig: disabled,
    }),
    false,
  );
  assert.equal(
    isOfficialCuaPluginEnabledForWorkspace({
      env: { ZCODE_CUA_PRODUCT_HELPER: "off" },
      userConfig: enabled,
    }),
    false,
  );
});

test("workspace plugin discovery matches project config order and suppression remains terminal", async (t) => {
  const root = await createTemporaryDirectory(t);
  const nested = join(root, "packages", "demo");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(nested, ".zcode"), { recursive: true });
  await writeFile(
    join(root, "zcode.json"),
    JSON.stringify({
      plugins: { enabledPlugins: { "computer-use@zcode-plugins-official": true } },
    }),
  );
  await writeFile(
    join(nested, ".zcode", "config.json"),
    JSON.stringify({
      plugins: { enabledPlugins: { "computer-use@zcode-plugins-official": false } },
    }),
  );
  assert.equal(
    isOfficialCuaPluginEnabledForWorkspace({ env: {}, workingDirectory: nested }),
    false,
  );

  await writeFile(
    join(nested, ".zcode", "config.json"),
    JSON.stringify({
      plugins: { enabledPlugins: { "computer-use@zcode-plugins-official": true } },
    }),
  );
  assert.equal(
    isOfficialCuaPluginEnabledForWorkspace({
      env: {},
      workingDirectory: nested,
      userConfig: {
        plugins: { suppressedBuiltins: ["computer-use@zcode-plugins-official"] },
      },
    }),
    false,
  );
});

test("probe and unavailable markers are strict and reversible", () => {
  assert.equal(isScreenCaptureProbeSuccess({ ok: true }), true);
  assert.equal(isScreenCaptureProbeSuccess({ ok: 1 }), false);
  const host = { start() {} };
  markCuaProductHelperAgentEnvUnavailable(host);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), true);
  clearCuaProductHelperAgentEnvUnavailable(host);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), false);
});

test("orphan reaper prefers canonical parent pid and accepts the legacy launcher pid", async () => {
  const terminated = [];
  await reapOrphanedHelpers({
    platform: "darwin",
    dependencies: {
      listProcesses: async () => [
        {
          pid: 101,
          command: "/Users/me/ZCode Computer Use.app/Contents/MacOS/helper --parent-pid 9001",
        },
        {
          pid: 102,
          command: "/Users/me/ZCode Computer Use.app/Contents/MacOS/helper --parent-pid=9002",
        },
        {
          pid: 103,
          command:
            "/Users/me/ZCode Computer Use.app/Contents/MacOS/helper --launcher-pid 9001 --parent-pid 9002",
        },
        {
          pid: 104,
          command: "/Users/me/ZCode Computer Use.app/Contents/MacOS/helper --launcher-pid 9003",
        },
        { pid: 105, command: "other --parent-pid 9001" },
      ],
      isProcessAlive: (pid) => pid === 9002,
      terminate: async (pid) => terminated.push(pid),
    },
  });
  assert.deepEqual(terminated, [101, 104]);
});

test("LaunchServices permission requests use the installed Helper and explicit permission kind", async () => {
  const launches = [];
  const common = {
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    helperAppPath: "/Applications/CUA.app",
    socketPath: "/tmp/cua-permission.sock",
    launcherPid: 12,
    launchApplication: async (input) => launches.push(input),
  };
  assert.deepEqual(await requestHelperAccessibilityPermissionViaLaunchServices(common), {
    ok: true,
  });
  assert.deepEqual(await requestHelperScreenRecordingPermissionViaLaunchServices(common), {
    ok: true,
  });
  assert.ok(launches[0].args.includes("accessibility"));
  assert.ok(launches[1].args.includes("screen_recording"));
  assert.equal(
    (await requestHelperAccessibilityPermissionViaLaunchServices({ platform: "win32" })).ok,
    false,
  );
});

test("LaunchServices screen preflight waits for a credential-free Helper and parses one bounded result", async () => {
  let exitLogPath;
  const state = await queryHelperScreenRecordingPreflightViaLaunchServices({
    platform: "darwin",
    env: { ZCODE_RUNTIME_ENV: "production" },
    helperAppPath: "/Applications/CUA.app",
    socketPath: "/tmp/cua-preflight.sock",
    launcherPid: 12,
    launchApplication: async ({ args }) => {
      assert.ok(args.includes("-W"));
      assert.ok(args.includes("--permission-preflight"));
      assert.equal(args.includes("--capability"), false);
      exitLogPath = args[args.indexOf("--exit-log") + 1];
      await writeFile(
        exitLogPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "permission_preflight",
          capability: "screen_recording",
          state: "granted",
        })}\n`,
      );
    },
  });

  assert.equal(state, "granted");
  assert.ok(exitLogPath);
  await assert.rejects(readFile(exitLogPath), { code: "ENOENT" });
  assert.equal(
    await queryHelperScreenRecordingPreflightViaLaunchServices({ platform: "win32" }),
    undefined,
  );
});

test("LaunchServices screen preflight rejects malformed or ambiguous diagnostics", async () => {
  const run = (contents) =>
    queryHelperScreenRecordingPreflightViaLaunchServices({
      platform: "darwin",
      env: { ZCODE_RUNTIME_ENV: "production" },
      helperAppPath: "/Applications/CUA.app",
      launchApplication: async ({ args }) => {
        const exitLogPath = args[args.indexOf("--exit-log") + 1];
        await writeFile(exitLogPath, contents);
      },
    });

  assert.equal(await run('{"event":"permission_preflight","state":"granted"}\n'), undefined);
  assert.equal(
    await run(
      `${JSON.stringify({
        event: "permission_preflight",
        capability: "screen_recording",
        state: "denied",
      })}\n{}\n`,
    ),
    undefined,
  );
});
