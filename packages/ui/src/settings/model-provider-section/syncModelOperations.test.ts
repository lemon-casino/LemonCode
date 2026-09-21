import assert from "node:assert/strict";
import test from "node:test";
import { runCancelablePool } from "./syncModelOperations.js";

test("probe pool never exceeds the configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const results: number[] = [];
  await runCancelablePool({
    items: [1, 2, 3, 4, 5, 6],
    concurrency: 3,
    shouldContinue: () => true,
    run: async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item;
    },
    onResult: (result) => results.push(result),
  });
  assert.equal(maximum, 3);
  assert.equal(results.length, 6);
});

test("cancellation stops scheduling remaining probes and drops late results", async () => {
  let continuing = true;
  let started = 0;
  const releases: Array<() => void> = [];
  const results: number[] = [];
  const running = runCancelablePool({
    items: [1, 2, 3, 4, 5],
    concurrency: 2,
    shouldContinue: () => continuing,
    run: async (item) => {
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return item;
    },
    onResult: (result) => results.push(result),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 2);
  continuing = false;
  for (const release of releases) release();
  await running;
  assert.equal(started, 2);
  assert.deepEqual(results, []);
});
