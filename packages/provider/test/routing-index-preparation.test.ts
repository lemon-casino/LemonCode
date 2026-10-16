import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { RoutingScheduler } from "../src/routing/scheduler.js";
const request = { scopeKey: "fixture", attemptId: "fixture", modelKey: "model" };
function catalog(count = 100000) {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 1 },
  );
  const ids = Array.from({ length: count }, (_, i) => String(i));
  const changed = new Set<string>();
  owner.setDirectory(ids, (id) => ({
    id,
    generation: "1",
    portability: "portable",
    quotaGroupId: "pool" + id,
    windows: [
      {
        resourceId: "q" + id,
        instanceId: "one",
        revision: changed.has(id) ? 2 : 1,
        kind: "budget",
        quality: "fresh",
        remaining: changed.has(id) ? 0 : 100000 - Number(id),
        limit: 100000,
        unit: "requests",
      },
    ],
  }));
  return { owner, changed };
}
test(
  "PC-06 100k cold projection yields bounded chunks and does not retain full candidates/cohorts",
  { timeout: 120000 },
  async (t) => {
    const { owner } = catalog();
    t.after(() => owner.dispose());
    let beats = 0,
      largest = 0;
    const started = performance.now();
    const build = owner.prepareIndexed(request);
    for (;;) {
      const at = performance.now(),
        next = build.next();
      largest = Math.max(largest, performance.now() - at);
      if (next.done) break;
      beats++;
      await immediate();
    }
    assert.ok(beats >= 100, "a cold profile must yield while building");
    const lease = owner.reserveIndexed(request);
    assert.equal(lease.routeId, "0");
    lease.cancel();
    const before = owner.indexDiagnostics()!.scannedKeys;
    for (let i = 0; i < 100; i++) {
      const lease = owner.reserveIndexed({ ...request, attemptId: String(i) });
      lease.cancel();
    }
    assert.equal(owner.indexDiagnostics()!.scannedKeys, before);
    assert.equal(owner.indexDiagnostics()!.cohortCount, 0);
    assert.ok(largest < 250, "one preparation step exceeded 250ms: " + largest);
    t.diagnostic(
      JSON.stringify({
        scenario: "100k-cooperative-cold-index",
        coldMs: performance.now() - started,
        largestStepMs: largest,
        yields: beats,
        rssMiB: process.memoryUsage().rss / 1048576,
        heapMiB: process.memoryUsage().heapUsed / 1048576,
        index: owner.indexDiagnostics(),
      }),
    );
  },
);
test("PC-06 quota changes during preparation cannot publish the old winner", () => {
  const { owner, changed } = catalog(1000);
  try {
    const build = owner.prepareIndexed(request);
    assert.equal(build.next().done, false);
    changed.add("0");
    owner.touchDirectory("0");
    for (const _ of build) {
    }
    const lease = owner.reserveIndexed(request);
    assert.notEqual(lease.routeId, "0");
    lease.cancel();
  } finally {
    owner.dispose();
  }
});
test("PC-06 changing policy fences an in-progress cold projection", () => {
  const { owner } = catalog(1000);
  try {
    const build = owner.prepareIndexed(request);
    build.next();
    owner.setPolicy({ version: 1, strategy: "primary-backup" });
    assert.throws(
      () => build.next(),
      (error) => (error as { code?: string }).code === "policy-conflict",
    );
  } finally {
    owner.dispose();
  }
});
