import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createResourceMeter,
  createTimerOwner,
  SAMPLE_CAP,
  slope,
  type ResourceSample,
} from "./metrics.js";
import { runStress } from "./harness.js";

test("resource sampler is bounded and computes byte-per-second slope from actual timestamps", () => {
  const samples: ResourceSample[] = [0, 1_000, 2_000].map((wallMs) => ({
    wallMs,
    rssBytes: 100 + wallMs * 2,
    heapUsedBytes: 50 + wallMs,
    cpuUserMicros: 0,
    cpuSystemMicros: 0,
  }));
  assert.equal(slope(samples, "rssBytes"), 2_000);
  assert.equal(slope(samples, "heapUsedBytes"), 1_000);
  assert.equal(slope([], "rssBytes"), 0);
  const meter = createResourceMeter();
  for (let index = 0; index < SAMPLE_CAP + 100; index++) meter.sample();
  const result = meter.summary();
  assert.equal(result.samples.length, SAMPLE_CAP);
  assert.ok(result.wallMs > 0);
  assert.ok(result.rssPeakBytes >= result.rssStartBytes);
});

test("real timer ownership accounts for fired and cancelled callbacks without retained handles", async () => {
  const owner = createTimerOwner();
  let callbacks = 0;
  const cancel = owner.schedule(() => {
    callbacks++;
  }, 100);
  owner.schedule(() => {
    callbacks++;
  }, 1);
  cancel();
  cancel();
  await sleep(10);
  assert.equal(callbacks, 1);
  assert.deepEqual(owner.summary(), {
    scheduled: 2,
    fired: 1,
    cancelled: 1,
    peak: 2,
    remaining: 0,
  });
});

test(
  "multi-actor real driver smoke preserves window, source times, retries, recovery and cleanup",
  { timeout: 90_000 },
  async () => {
    const result = await runStress({
      actors: 3,
      warmupMs: 100,
      durationMs: 1_000,
      deltasPerSecond: 20,
    });
    assert.equal(result.passed, true);
    assert.equal(result.measuredCounts?.inputDeltas, 60);
    assert.ok(result.measuredWallMs >= 1_000);
    assert.equal(result.projection?.maxActiveNodes, 3);
    assert.equal(result.projection?.maxNodes, 256);
    assert.equal(result.projection?.truncatedObserved, true);
    assert.equal(result.projection?.onlineRecoveryEqual, true);
    assert.equal(result.counts.actorRetries, 1);
    assert.equal(result.counts.asksStarted, result.counts.asksSettled);
    assert.ok(result.counts.lateEventsRejected > 256);
    assert.equal(result.cleanup.remaining, 0);
    assert.equal(result.cleanup.listenersRemaining, 0);
    assert.equal(result.cleanup.subscribersRemaining, 0);
    assert.equal(result.cleanup.closedRuntimes, 3);
    assert.equal(result.journal.costIncludedInResources, true);
  },
);
