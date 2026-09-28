import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSessionRecallBenchmark,
  nearestRank,
  summarizeDurations,
} from "./session-recall-benchmark-stats.mjs";

test("SRB-02 nearest-rank percentiles are deterministic", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1).reverse();
  assert.equal(nearestRank(values, 0.5), 50);
  assert.equal(nearestRank(values, 0.95), 95);
  assert.equal(nearestRank(values, 0.99), 99);
  assert.deepEqual(summarizeDurations([1, 2, 3, 4]), {
    minMs: 1,
    meanMs: 2.5,
    p50Ms: 2,
    p95Ms: 4,
    p99Ms: 4,
    maxMs: 4,
  });
});

test("SRB-03 threshold and invariant failures make the decision fail", () => {
  const failed = evaluateSessionRecallBenchmark({
    durations: [10, 160, 320],
    invariantFailures: ["empty_matches"],
    thresholds: { p95Ms: 150, p99Ms: 300 },
  });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failures, [
    "empty_matches",
    "p95_threshold_exceeded",
    "p99_threshold_exceeded",
  ]);

  const passed = evaluateSessionRecallBenchmark({
    durations: [10, 20, 30],
    invariantFailures: [],
    thresholds: { p95Ms: 150, p99Ms: 300 },
  });
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.failures, []);
});
