import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { MEMORY_RECALL_SCAN_CONCURRENCY, ProjectMemoryRecallIndex } from "./index.js";
import { mapWithFixedConcurrency } from "./concurrency.js";
import { createRecallHarness } from "./recall.test-support.js";

const ROOT = resolve("/recall-cancellation-fixture/memory");

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("recall never admits more than eight concurrent stats or reads", async () => {
  const harness = createRecallHarness(
    new Map(
      Array.from({ length: 20 }, (_, index) => [
        join(ROOT, `topic-${index}.md`),
        { content: "alpha memory" },
      ]),
    ),
  );
  const stat = harness.fileSystem.stat.bind(harness.fileSystem);
  const read = harness.fileSystem.readTextFile.bind(harness.fileSystem);
  const statBatch = barrier();
  const readBatch = barrier();
  const allowStats = barrier();
  const allowReads = barrier();
  let activeStats = 0;
  let activeReads = 0;
  let peakStats = 0;
  let peakReads = 0;
  harness.fileSystem.stat = async (request, options) => {
    activeStats += 1;
    peakStats = Math.max(peakStats, activeStats);
    if (activeStats === MEMORY_RECALL_SCAN_CONCURRENCY) statBatch.release();
    await allowStats.promise;
    try {
      return await stat(request, options);
    } finally {
      activeStats -= 1;
    }
  };
  harness.fileSystem.readTextFile = async (request, options) => {
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    if (activeReads === MEMORY_RECALL_SCAN_CONCURRENCY) readBatch.release();
    await allowReads.promise;
    try {
      return await read(request, options);
    } finally {
      activeReads -= 1;
    }
  };
  const recall = new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  await statBatch.promise;
  assert.equal(harness.reads.length, 0);
  assert.equal(activeStats, MEMORY_RECALL_SCAN_CONCURRENCY);
  allowStats.release();
  await readBatch.promise;
  assert.equal(activeReads, MEMORY_RECALL_SCAN_CONCURRENCY);
  allowReads.release();
  const outcome = await recall;
  assert.equal(outcome.indexedCount, 20);
  assert.equal(peakStats, MEMORY_RECALL_SCAN_CONCURRENCY);
  assert.equal(peakReads, MEMORY_RECALL_SCAN_CONCURRENCY);
});

test("abort promptly rejects blocked reads even when a port ignores its signal", async () => {
  const harness = createRecallHarness(
    new Map(
      Array.from({ length: 20 }, (_, index) => [
        join(ROOT, `topic-${index}.md`),
        { content: "alpha memory" },
      ]),
    ),
  );
  const read = harness.fileSystem.readTextFile.bind(harness.fileSystem);
  const started = barrier();
  const release = barrier();
  let admitted = 0;
  harness.fileSystem.readTextFile = async (request, options) => {
    admitted += 1;
    if (admitted === MEMORY_RECALL_SCAN_CONCURRENCY) started.release();
    await release.promise;
    return read(request, options);
  };
  const controller = new AbortController();
  const cancelled = new Error("test cancellation");
  const index = new ProjectMemoryRecallIndex();
  const recall = index.recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
    signal: controller.signal,
  });
  const rejected = assert.rejects(recall, (error) => error === cancelled);
  await started.promise;
  controller.abort(cancelled);
  try {
    await rejected;
    assert.equal(admitted, MEMORY_RECALL_SCAN_CONCURRENCY);
    assert.equal(index.size, 0);
  } finally {
    release.release();
  }
});

test("directory abort stops waiting without starting stat work", async () => {
  const harness = createRecallHarness(new Map());
  const started = barrier();
  const release = barrier();
  const list = harness.fileSystem.listDirectory.bind(harness.fileSystem);
  harness.fileSystem.listDirectory = async (request, options) => {
    started.release();
    await release.promise;
    return list(request, options);
  };
  const controller = new AbortController();
  const index = new ProjectMemoryRecallIndex();
  const recall = index.recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
    signal: controller.signal,
  });
  const rejected = assert.rejects(recall, { name: "AbortError" });
  await started.promise;
  controller.abort();
  try {
    await rejected;
    assert.equal(harness.stats.length, 0);
  } finally {
    release.release();
  }
});

test("an adapter cancellation without a signal stops further worker admission", async () => {
  const cancelled = Object.assign(new Error("cancelled"), { code: "cancelled" });
  let admitted = 0;
  await assert.rejects(
    mapWithFixedConcurrency([1, 2, 3], 1, async () => {
      admitted += 1;
      throw cancelled;
    }),
    (error) => error === cancelled,
  );
  assert.equal(admitted, 1);
});
