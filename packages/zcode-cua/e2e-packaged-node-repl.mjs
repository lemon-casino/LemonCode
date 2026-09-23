// Windows 打包链真机自检：packaged CLI -> shared node_repl -> runtime -> packaged Helper。
// 默认不读取桌面；显式设置 ZCODE_CUA_PACKAGED_NODE_REPL_E2E=1 才执行，且只调用 list_apps。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  BROKER_CAPABILITY_ENV,
  BROKER_GENERATION_ENV,
  createHelperBootstrapCredentials,
  mintBrokerSocketPath,
  parseHelperBootstrapRequest,
} from "./broker.js";
import { HELPER_ADDON_ENV, HELPER_CONTROL_PROTOCOL } from "./broker-helper-constants.js";

const ENABLE_ENV = "ZCODE_CUA_PACKAGED_NODE_REPL_E2E";
const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
const PLUGIN_AUTHORITY_ENV = "ZCODE_CUA_PLUGIN_AUTHORITY";
const NODE_REPL_HOST_ENV = "ZCODE_CUA_NODE_REPL_HOST";
const PLUGIN_ID_ENV = "ZCODE_PLUGIN_ID";
const OFFICIAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MAX_DIAGNOSTIC_BYTES = 8192;

const enabled = process.env[ENABLE_ENV] === "1";
if (!enabled) {
  console.log(`e2e-packaged-node-repl: skipped (set ${ENABLE_ENV}=1 after building win-unpacked)`);
  process.exit(0);
}
if (process.platform !== "win32") {
  console.log("e2e-packaged-node-repl: skipped (Windows packaged validation only)");
  process.exit(0);
}

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "..", "..");
const unpackedRoot = resolve(repoRoot, "packages", "desktop", "dist", "win-unpacked");
const executable = resolve(unpackedRoot, "ZCode.exe");
const resourcesRoot = resolve(unpackedRoot, "resources");
const helperRoot = resolve(resourcesRoot, "tools", "cua-helper");
const helperEntry = resolve(helperRoot, "helper-entry.js");
const helperAddon = resolve(helperRoot, "xa11y-native-loader.js");
const glmRoot = resolve(resourcesRoot, "glm");
const agentEntry = resolve(glmRoot, "zcode.cjs");
const nodeReplServer = resolve(glmRoot, "packages", "node-repl-host", "dist", "mcp", "server.js");
const cuaPluginRoot = resolve(glmRoot, "packages", "zcode-cua-plugin");
const cuaClient = resolve(cuaPluginRoot, "scripts", "computer-use-client.mjs");

const requiredArtifacts = [
  executable,
  helperEntry,
  helperAddon,
  agentEntry,
  nodeReplServer,
  cuaClient,
];
for (const artifact of requiredArtifacts) {
  try {
    await access(artifact);
  } catch (error) {
    throw new Error(
      `Packaged Computer Use E2E artifact is missing: ${artifact}. ` +
        "Run pnpm bundle:desktop -- --os win --arch x64 first.",
      { cause: error },
    );
  }
}

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
const socketPath = mintBrokerSocketPath();
const capability = randomBytes(32).toString("base64url");
const generation = 0;
const helperEnv = {
  ...baseEnv,
  ELECTRON_RUN_AS_NODE: "1",
  [HELPER_ADDON_ENV]: helperAddon,
};
delete helperEnv[PLUGIN_AUTHORITY_ENV];
delete helperEnv[BROKER_CAPABILITY_ENV];
delete helperEnv[BROKER_GENERATION_ENV];

const helper = fork(helperEntry, ["--socket", socketPath, "--parent-pid", String(process.pid)], {
  cwd: helperRoot,
  env: helperEnv,
  execPath: executable,
  silent: true,
  windowsHide: true,
});
let helperDiagnostics = "";
helper.stderr?.on("data", (chunk) => {
  helperDiagnostics = appendDiagnostic(helperDiagnostics, chunk);
});

const helperReady = waitForHelperReady();
let client;
let mcpDiagnostics = "";

try {
  await helperReady;

  const transport = new StdioClientTransport({
    command: executable,
    args: [agentEntry, "__zcode-plugin-host", nodeReplServer],
    cwd: repoRoot,
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: "1",
      ZCODE_RUNTIME_ENV: "production",
      [BROKER_SOCKET_ENV]: socketPath,
      [PLUGIN_AUTHORITY_ENV]: capability,
      [BROKER_GENERATION_ENV]: String(generation),
      [NODE_REPL_HOST_ENV]: "1",
      [PLUGIN_ID_ENV]: OFFICIAL_CUA_PLUGIN_ID,
      ZCODE_CUA_PLUGIN_ROOT: cuaPluginRoot,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    mcpDiagnostics = appendDiagnostic(mcpDiagnostics, chunk);
  });
  client = new Client(
    { name: "zcode-packaged-cua-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
  );
  await client.connect(transport, { timeout: 20_000 });

  // 回归覆盖点：CLI 入口会先把 socket + authority 从 process.env 成组清洗。官方 plugin-host
  // 必须在 node_repl main() 捕获 runtime 前成组恢复二者；历史实现只恢复 socket，最终稳定返回
  // "Computer Use is unavailable for this node_repl session"。真实 list_apps 穿透整条链才能证明修复。
  const code = `
const root = process.env.ZCODE_CUA_PLUGIN_ROOT;
if (!root) throw new Error("ZCODE_CUA_PLUGIN_ROOT is missing");
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href
);
await setupComputerUseRuntime({ globals: globalThis });
const apps = await agent.computerUse.computer.list_apps({});
if (!Array.isArray(apps) || apps.length === 0) {
  throw new Error("Packaged node_repl list_apps returned no applications");
}
({ appCount: apps.length });
`;
  const result = await client.callTool(
    {
      name: "js",
      arguments: { code, title: "Validate packaged Computer Use application discovery" },
      _meta: {
        "com.zcode/request-context": {
          runtime_scope: "main",
          session_id: "packaged-cua-e2e",
          workspace_key: "packaged-cua-e2e",
          workspace_path: repoRoot,
          client_mode: "desktop-continuous",
          delivery_kind: "desktop-continuous",
        },
      },
    },
    { timeout: 30_000 },
  );
  assert.notEqual(result.isError, true, describeMcpFailure(result));
  assert.ok(
    Array.isArray(result.structuredContent) && result.structuredContent.length > 0,
    `Packaged node_repl list_apps returned no structured applications: ${describeMcpFailure(result)}`,
  );
  console.log(
    `e2e-packaged-node-repl: packaged CLI + node_repl + Helper list_apps ok (${result.structuredContent.length} applications)`,
  );
  console.log("e2e-packaged-node-repl: PASS");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    [
      message,
      mcpDiagnostics ? `MCP stderr:\n${mcpDiagnostics}` : "",
      helperDiagnostics ? `Helper stderr:\n${helperDiagnostics}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    { cause: error },
  );
} finally {
  await client?.close().catch(() => undefined);
  if (helper.exitCode === null && helper.signalCode === null) {
    helper.send?.({ protocol: HELPER_CONTROL_PROTOCOL, type: "shutdown" });
    try {
      await waitForHelperExit(3000);
    } catch {
      helper.kill();
      await waitForHelperExit(3000).catch(() => undefined);
    }
  }
}

function appendDiagnostic(current, chunk) {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_BYTES);
}

function describeMcpFailure(result) {
  return JSON.stringify({ content: result?.content, isError: result?.isError });
}

function waitForHelperReady(timeoutMs = 15_000) {
  return new Promise((resolveReady, rejectReady) => {
    let bootstrapped = false;
    const timer = setTimeout(
      () => fail(new Error("Packaged Helper did not report ready before the deadline.")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      helper.off("message", onMessage);
      helper.off("error", onError);
      helper.off("exit", onExit);
    };
    const fail = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onMessage = (message) => {
      if (message?.protocol !== HELPER_CONTROL_PROTOCOL) return;
      if (message.type === "bootstrap_request") {
        const request = parseHelperBootstrapRequest(message);
        if (bootstrapped || !request || request.pid !== helper.pid) {
          fail(new Error("Packaged Helper returned an invalid credential bootstrap challenge."));
          return;
        }
        bootstrapped = true;
        try {
          helper.send(
            createHelperBootstrapCredentials({
              pid: request.pid,
              nonce: request.nonce,
              capability,
              generation,
            }),
            (error) => {
              if (error) fail(error);
            },
          );
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (message.type === "error") {
        fail(new Error(message.message || "Packaged Helper reported a startup error."));
        return;
      }
      if (message.type !== "ready") return;
      if (!bootstrapped || message.pid !== helper.pid || message.socketPath !== socketPath) {
        fail(new Error("Packaged Helper returned an invalid ready message."));
        return;
      }
      cleanup();
      resolveReady();
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) =>
      fail(
        new Error(
          `Packaged Helper exited before ready (code=${String(code)}, signal=${String(signal)}). ${helperDiagnostics}`,
        ),
      );
    helper.on("message", onMessage);
    helper.once("error", onError);
    helper.once("exit", onExit);
  });
}

function waitForHelperExit(timeoutMs = 10_000) {
  if (helper.exitCode !== null || helper.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      helper.off("exit", onExit);
      rejectExit(new Error("Packaged Helper did not exit before the deadline."));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    helper.once("exit", onExit);
  });
}
