import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { HELPER_CONTROL_PROTOCOL } from "@zcode/zcode-cua/broker/server";

import { WindowsCuaHelperHost } from "./windowsCuaDevHelperHost.js";
import type {
  WindowsCuaChild,
  WindowsCuaChildProcessAdapter,
} from "./windowsCuaHelperHostSupport.js";

class FakeChild extends EventEmitter implements WindowsCuaChild {
  readonly pid = 4242;
  readonly sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    const value = message as { type?: string };
    if (value.type === "bootstrap_credentials") {
      queueMicrotask(() => {
        this.emit("message", {
          protocol: HELPER_CONTROL_PROTOCOL,
          type: "transport_ready",
          socketPath: "helper-pipe",
          pid: this.pid,
        });
        this.emit("message", {
          protocol: HELPER_CONTROL_PROTOCOL,
          type: "ready",
          socketPath: "helper-pipe",
          pid: this.pid,
        });
      });
    } else if (value.type === "shutdown") {
      queueMicrotask(() => this.emit("exit", 0));
    }
    return true;
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

const runtime = {
  platform: "linux" as const,
  root: "/runtime",
  entryPath: "/runtime/helper-entry.js",
  addonPath: "/runtime/xa11y-native-loader.js",
  command: process.execPath,
  commandEnv: {
    ZCODE_CUA_PLUGIN_AUTHORITY: "must-not-leak",
    ZCODE_CUA_PERMISSION_BROKER_CAPABILITY: "must-not-leak",
    ZCODE_CUA_PERMISSION_BROKER_GENERATION: "99",
  },
};

test("Node Helper host bootstraps credentials over exact child IPC only", async () => {
  const child = new FakeChild();
  let forkCall: { command: string; argv: string[]; env: NodeJS.ProcessEnv | undefined } | undefined;
  const childProcess: WindowsCuaChildProcessAdapter = {
    fork(command, argv, options) {
      forkCall = { command, argv, env: options.env };
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
  };
  const host = new WindowsCuaHelperHost({
    runtime,
    childProcess,
    mintSocketPath: () => "helper-pipe",
    mintPluginAuthority: () => "authority",
    healthProbe: async () => ({ bundleId: null, pid: child.pid }),
  });

  const handle = await host.start();
  assert.equal(handle.pid, child.pid);
  assert.ok(forkCall);
  assert.equal(forkCall.argv.includes("--capability"), false);
  assert.equal(forkCall.argv.includes("--generation"), false);
  assert.equal(forkCall.env?.ZCODE_CUA_PLUGIN_AUTHORITY, undefined);
  assert.equal(forkCall.env?.ZCODE_CUA_PERMISSION_BROKER_CAPABILITY, undefined);
  assert.equal(forkCall.env?.ZCODE_CUA_PERMISSION_BROKER_GENERATION, undefined);
  assert.deepEqual(child.sent[0], {
    protocol: HELPER_CONTROL_PROTOCOL,
    type: "bootstrap_credentials",
    pid: child.pid,
    nonce: "challenge",
    capability: "authority",
    generation: 0,
  });
  await host.stop();
});

test("Node Helper host rejects ready before credential bootstrap", async () => {
  const child = new FakeChild();
  const host = new WindowsCuaHelperHost({
    runtime,
    childProcess: {
      fork() {
        queueMicrotask(() =>
          child.emit("message", {
            protocol: HELPER_CONTROL_PROTOCOL,
            type: "ready",
            socketPath: "helper-pipe",
            pid: child.pid,
          }),
        );
        return child;
      },
    },
    mintSocketPath: () => "helper-pipe",
    mintPluginAuthority: () => "authority",
    healthProbe: async () => ({ bundleId: null, pid: child.pid }),
  });

  await assert.rejects(host.start(), /credential bootstrap/u);
});
