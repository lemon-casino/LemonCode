import assert from "node:assert/strict";
import { test } from "node:test";

import type { CuaHelperHandle } from "@zcode/zcode-cua/broker/server";

import {
  buildCuaProductHelperAgentEnv,
  createDefaultCuaProductHelper,
  shouldCreateDefaultCuaProductHelper,
  shouldEnableDefaultCuaProductHelper,
} from "./node.js";
import type { ManagedCuaProductHelperHost } from "./cua-permission-broker/windowsCuaDevHelperHost.js";

const handle: CuaHelperHandle = {
  socketPath: "/tmp/zcode-cua-test.sock",
  pipSocketPath: "/tmp/zcode-cua-test.pip.sock",
  launchSocketPath: "/tmp/zcode-cua-test.sock",
  pluginAuthority: "test-authority",
  helperAppPath: "/tmp/zcode-cua/helper-entry.js",
  bundleId: "dev.zcode.cua-helper",
  pid: 42,
  generation: 7,
};

function fakeHost(calls: string[]): ManagedCuaProductHelperHost {
  return {
    running: false,
    socketPath: null,
    pluginAuthority: null,
    async start() {
      calls.push("start");
      return handle;
    },
    async stop() {
      calls.push("stop");
    },
    async restart() {
      calls.push("restart");
      return handle;
    },
    async restartAfterCurrentStart() {
      calls.push("restart-after-current-start");
      return handle;
    },
    async checkHealth() {
      calls.push("check-health");
      return { bundleId: "dev.zcode.cua-helper", pid: 42 };
    },
  };
}

test("enables the open product Helper on Linux unless explicitly disabled", () => {
  assert.equal(shouldEnableDefaultCuaProductHelper({ platform: "linux", env: {} }), true);
  for (const value of ["0", "false", "off", " FALSE ", " Off "]) {
    assert.equal(
      shouldEnableDefaultCuaProductHelper({
        platform: "linux",
        env: { ZCODE_CUA_PRODUCT_HELPER: value },
      }),
      false,
      value,
    );
  }
  assert.equal(
    shouldEnableDefaultCuaProductHelper({
      platform: "linux",
      env: { ZCODE_CUA_PRODUCT_HELPER: "unexpected" },
    }),
    true,
  );
  assert.equal(shouldEnableDefaultCuaProductHelper({ platform: "freebsd", env: {} }), false);
});

test("keeps Helper platform availability separate from workspace admission", () => {
  const base = {
    serviceAuthorityMode: "desktop-local" as const,
    hasRemoteWorkspaceIdentity: false,
    hasInjectedResolver: false,
  };
  assert.equal(shouldCreateDefaultCuaProductHelper({ ...base, hasBuiltInCuaPlugin: false }), false);
  assert.equal(shouldCreateDefaultCuaProductHelper({ ...base, hasBuiltInCuaPlugin: true }), true);
});

test("assembles Linux through the lazy Node runtime host and honors stop", async () => {
  const calls: string[] = [];
  const helper = createDefaultCuaProductHelper({
    platform: "linux",
    env: {},
    resolveNodeRuntime: async () => {
      calls.push("resolve-runtime");
      return {
        platform: "linux",
        root: "/tmp/zcode-cua",
        entryPath: "/tmp/zcode-cua/helper-entry.js",
        addonPath: "/tmp/zcode-cua/xa11y-native-loader.js",
        command: process.execPath,
        commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
      };
    },
    createNodeHost: () => {
      calls.push("create-host");
      return fakeHost(calls);
    },
  });

  assert.ok(helper);
  assert.deepEqual(calls, []);
  await helper.host.start();
  assert.deepEqual(calls, ["resolve-runtime", "create-host", "start"]);
  await helper.host.stop();
  assert.equal(calls.at(-1), "stop");
  await assert.rejects(helper.host.start(), /startup stopped/u);
  assert.equal(calls.filter((call) => call === "create-host").length, 1);
});

test("agent env forwards the complete broker generation tuple", async () => {
  const calls: string[] = [];
  assert.deepEqual(await buildCuaProductHelperAgentEnv(fakeHost(calls)), {
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-test.sock",
    ZCODE_CUA_PLUGIN_AUTHORITY: "test-authority",
    ZCODE_CUA_PERMISSION_BROKER_GENERATION: "7",
  });
  assert.deepEqual(calls, ["start"]);
});
