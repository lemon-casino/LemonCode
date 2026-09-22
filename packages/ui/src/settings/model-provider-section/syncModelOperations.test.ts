import assert from "node:assert/strict";
import test from "node:test";
import {
  runCancelablePool,
  runSequentialModelMutation,
  selectedModelIds,
} from "./syncModelOperations.js";

test("selection snapshot keeps only checked rows in visible order", () => {
  const rows = ["remote-a", "remote-b", "local-only"];
  assert.deepEqual(selectedModelIds(rows, new Set(rows)), rows);
  assert.deepEqual(selectedModelIds(rows, new Set(["local-only", "remote-b"])), [
    "remote-b",
    "local-only",
  ]);
  assert.deepEqual(selectedModelIds(rows, new Set()), []);
});

test("one sync submits every selected model even when the parent updates between saves", async () => {
  const selected = selectedModelIds(
    ["remote-a", "remote-b", "remote-c"],
    new Set(["remote-a", "remote-c"]),
  );
  const saved: string[] = [];
  const progress: number[] = [];
  await runSequentialModelMutation({
    items: selected,
    shouldContinue: () => true,
    run: async (id) => {
      saved.push(id);
      await Promise.resolve();
    },
    onProgress: (completed) => progress.push(completed),
  });
  assert.deepEqual(saved, ["remote-a", "remote-c"]);
  assert.deepEqual(progress, [0, 1, 2]);
});

test("sequential sync stops scheduling after close", async () => {
  let open = true;
  const saved: string[] = [];
  await runSequentialModelMutation({
    items: ["a", "b", "c"],
    shouldContinue: () => open,
    run: async (id) => {
      saved.push(id);
      open = false;
    },
    onProgress: () => {},
  });
  assert.deepEqual(saved, ["a"]);
});

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
