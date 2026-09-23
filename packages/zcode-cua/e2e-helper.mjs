// 产品链路真机自检：公开 runtime -> broker -> 独立 Helper -> xa11y UIA/AX。
// 默认不读取桌面；Windows 上显式设置 ZCODE_CUA_HELPER_E2E=1 才执行。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROKER_CAPABILITY_ENV,
  BROKER_GENERATION_ENV,
  callBrokerMethod,
  createHelperBootstrapCredentials,
  mintBrokerSocketPath,
  parseHelperBootstrapRequest,
  probeHelperHealth,
} from "./broker.js";
import { HELPER_ADDON_ENV, HELPER_CONTROL_PROTOCOL } from "./broker-helper-constants.js";
import { findOfficialCuaFrameContentPair } from "./frame-contract.js";
import { createComputerUseRuntime } from "./index.js";

const enabled = process.env.ZCODE_CUA_HELPER_E2E === "1";
const targetAppName = process.env.ZCODE_CUA_E2E_APP_NAME?.trim();
if (!enabled) {
  console.log("e2e-helper: skipped (set ZCODE_CUA_HELPER_E2E=1 on a real Windows desktop)");
  process.exit(0);
}
if (process.platform !== "win32") {
  console.log("e2e-helper: skipped (Windows real-machine validation only)");
  process.exit(0);
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const helperEntry = resolve(currentDirectory, "helper-entry.js");
const addonLoader = resolve(currentDirectory, "xa11y-native-loader.js");
const socketPath = mintBrokerSocketPath();
const capability = randomBytes(32).toString("base64url");
const generation = 1;
const helperEnv = { ...process.env, [HELPER_ADDON_ENV]: addonLoader };
delete helperEnv.ZCODE_CUA_PLUGIN_AUTHORITY;
delete helperEnv[BROKER_CAPABILITY_ENV];
delete helperEnv[BROKER_GENERATION_ENV];
const child = fork(helperEntry, ["--socket", socketPath, "--parent-pid", String(process.pid)], {
  env: helperEnv,
  silent: true,
});
let helperDiagnostics = "";
child.stderr?.on("data", (chunk) => {
  helperDiagnostics = `${helperDiagnostics}${chunk.toString("utf8")}`.slice(-8192);
});

function waitForReady(timeoutMs = 15_000) {
  return new Promise((resolveReady, rejectReady) => {
    let bootstrapped = false;
    const timer = setTimeout(
      () => rejectReady(new Error("Helper did not report ready before the deadline.")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.protocol !== HELPER_CONTROL_PROTOCOL) return;
      if (message.type === "bootstrap_request") {
        const request = parseHelperBootstrapRequest(message);
        if (bootstrapped || !request || request.pid !== child.pid) {
          cleanup();
          rejectReady(new Error("Helper returned an invalid credential bootstrap challenge."));
          return;
        }
        bootstrapped = true;
        try {
          child.send(
            createHelperBootstrapCredentials({
              pid: request.pid,
              nonce: request.nonce,
              capability,
              generation,
            }),
            (error) => {
              if (!error) return;
              cleanup();
              rejectReady(error);
            },
          );
        } catch (error) {
          cleanup();
          rejectReady(error);
        }
        return;
      }
      if (message.type !== "ready") return;
      if (!bootstrapped) {
        cleanup();
        rejectReady(new Error("Helper reported ready before credential bootstrap."));
        return;
      }
      cleanup();
      resolveReady();
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(
        new Error(
          `Helper exited before ready (code=${String(code)}, signal=${String(signal)}). ${helperDiagnostics}`,
        ),
      );
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

const ready = waitForReady();

function waitForExit(timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      rejectExit(new Error("Helper did not exit before the deadline."));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    child.once("exit", onExit);
  });
}

const context = {
  workspaceKey: "e2e-helper-workspace",
  sessionId: "e2e-helper-session",
  runtimeScope: "main",
};
const runtime = createComputerUseRuntime({
  brokerSocketPath: socketPath,
  brokerCapability: capability,
  brokerGeneration: generation,
  logger: {
    warn(message, meta) {
      console.error(`e2e-helper: ${message}`, meta);
    },
  },
});

function structuredArray(result, label) {
  assert.ok(!result?.isError, `${label} failed: ${JSON.stringify(result?.content)}`);
  assert.ok(Array.isArray(result.structuredContent), `${label} returned no structured array`);
  return result.structuredContent;
}

try {
  await ready;
  const health = await probeHelperHealth(socketPath, { capability, generation, timeoutMs: 5000 });
  assert.equal(health.pid, child.pid);

  const apps = structuredArray(
    await runtime.execute({ toolName: "list_apps", arguments: {}, context }),
    "list_apps",
  );
  assert.ok(apps.length > 0, "list_apps returned no applications");

  let observation;
  if (targetAppName) {
    const state = await runtime.execute({
      toolName: "get_app_state",
      arguments: {
        app_ref: { name: targetAppName },
        include_screenshot: true,
        disable_diffing: true,
      },
      context,
    });
    assert.ok(
      !state?.isError,
      `get_app_state(${JSON.stringify(targetAppName)}) failed: ${JSON.stringify(state?.content)}`,
    );
    assert.ok(
      Array.isArray(state?.structuredContent?.elements),
      `get_app_state(${JSON.stringify(targetAppName)}) returned no accessibility elements`,
    );
    const framePair = findOfficialCuaFrameContentPair(state.content);
    assert.ok(
      framePair,
      `get_app_state(${JSON.stringify(targetAppName)}) returned no official PNG frame`,
    );
    observation = { state, framePair };
  } else {
    for (const app of [...apps].sort((left, right) => Number(right.active) - Number(left.active))) {
      if (!Number.isSafeInteger(app?.pid) || app.pid <= 0) continue;
      const windowsResult = await runtime.execute({
        toolName: "list_windows",
        arguments: { app_ref: { pid: app.pid } },
        context,
      });
      if (windowsResult?.isError || !Array.isArray(windowsResult?.structuredContent)) continue;
      const windows = [...windowsResult.structuredContent].sort(
        (left, right) =>
          Number(right.focused) - Number(left.focused) || Number(right.main) - Number(left.main),
      );
      for (const window of windows) {
        const appRef = {
          pid: app.pid,
          ...(Number.isSafeInteger(window.window_id) ? { window_id: window.window_id } : {}),
        };
        const state = await runtime.execute({
          toolName: "get_app_state",
          arguments: { app_ref: appRef, include_screenshot: true, disable_diffing: true },
          context,
        });
        if (state?.isError || !Array.isArray(state?.structuredContent?.elements)) continue;
        const framePair = findOfficialCuaFrameContentPair(state.content);
        if (!framePair) continue;
        observation = { state, framePair };
        break;
      }
      if (observation) break;
    }
  }
  assert.ok(observation, "No window returned both an accessibility tree and an official PNG frame");

  const { state, framePair } = observation;
  const frameRef = JSON.parse(framePair.imageRef.text);
  const png = Buffer.from(framePair.image.data, "base64");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  console.log(
    `e2e-helper: UIA + screenshot ok (${frameRef.width}x${frameRef.height}, ${state.structuredContent.elements.length} elements)`,
  );

  await runtime.closeSession(context);
  await callBrokerMethod({
    socketPath,
    capability,
    generation,
    method: "shutdown",
    params: {},
  });
  await waitForExit();
  console.log("e2e-helper: closeSession + shutdown ok");
  console.log("e2e-helper: PASS");
} finally {
  await runtime.dispose();
  if (child.exitCode === null && child.signalCode === null) {
    child.send?.({ protocol: HELPER_CONTROL_PROTOCOL, type: "shutdown" });
    try {
      await waitForExit(3000);
    } catch {
      child.kill();
      await waitForExit(3000).catch(() => undefined);
    }
  }
}
