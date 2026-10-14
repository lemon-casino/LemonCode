import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright-core";
import { createManagedCdpBrowserRuntime } from "./index.js";
import type { PlaywrightChromiumModule } from "./executable.js";

test("CDP retains an unconfirmed physical close and never closes its browser twice", async () => {
  let resolve!: () => void;
  const cleanup = new Promise<void>(done => { resolve = done; });
  let closeCalls = 0;
  let connected = true;
  const browser = {
    on() {},
    isConnected: () => connected,
    close: async () => { closeCalls++; await cleanup; connected = false; },
  } as Browser;
  const runtime = createManagedCdpBrowserRuntime({
    executablePath: process.execPath,
    closeTimeoutMs: 1,
    loadPlaywright: async () => ({ chromium: { launch: async () => browser } }) as unknown as PlaywrightChromiumModule,
  });
  try {
    await runtime.browserControlPort.list({ sessionId: "fixture" });
    assert.equal((await runtime.browserControlPort.closeSession!({ sessionId: "fixture" })).phase, "cleanup_pending");
    assert.equal((await runtime.browserControlPort.closeSession!({ sessionId: "fixture" })).phase, "cleanup_pending");
    assert.equal(closeCalls, 1);
    resolve();
    assert.equal((await runtime.browserControlPort.closeSession!({ sessionId: "fixture" })).phase, "closed");
    assert.equal(closeCalls, 1);
  } finally { resolve(); await runtime.close(); }
});
