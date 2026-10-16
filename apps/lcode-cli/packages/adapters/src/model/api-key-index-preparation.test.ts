import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";
test(
  "PC-06 API cold acquire coalesces 100k preparation and a cancelled waiter owns no reservation",
  { timeout: 120000 },
  async (t) => {
    const registry = new ApiKeyPoolRegistry();
    t.after(() => registry.dispose());
    const keys = Array.from({ length: 100000 }, (_, i) => ({
      id: "key" + i,
      apiKey: "fixture" + i,
    }));
    const pool = registry.get("fixture", "generation", keys, {
      version: 1,
      strategy: "share-rotation",
    });
    const abort = new AbortController();
    let ticks = 0,
      running = true;
    t.after(() => {
      running = false;
    });
    const heartbeat = (async () => {
      while (running) {
        await immediate();
        ticks++;
      }
    })();
    const context = { scopeKey: "scope", modelKey: "model", workUnits: 1 };
    const first = pool.acquire(abort.signal, undefined, { ...context, attemptId: "cancelled" });
    const firstResult = assert.rejects(first);
    void firstResult.catch(() => {});
    const second = pool.acquire(undefined, undefined, { ...context, attemptId: "accepted" });
    await immediate();
    abort.abort();
    const lease = await second;
    await firstResult;
    running = false;
    await heartbeat;
    assert.ok(ticks > 10, "cold acquire blocked the event loop");
    assert.equal(pool.activeLeaseCount, 1);
    assert.equal(pool.readRoutingDiagnostics({ limit: 1 }).index!.builds, 1);
    assert.equal(pool.readRoutingDiagnostics({ limit: 1 }).index!.scannedKeys, 100000);
    lease.release();
    assert.equal(pool.activeLeaseCount, 0);
    t.diagnostic(
      JSON.stringify({
        scenario: "api-100k-coalesced-cancelled-waiter",
        ticks,
        index: pool.readRoutingDiagnostics({ limit: 1 }).index,
      }),
    );
  },
);
