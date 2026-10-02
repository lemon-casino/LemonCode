import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT,
  MEMORY_RECALL_DIRECTORY_LIMIT,
  MEMORY_RECALL_FILE_LIMIT,
  ProjectMemoryRecallIndex,
  scanMemoryManifest,
} from "./index.js";
import { collectMemoryCandidatePaths, scanMemoryCandidatePaths } from "./manifest.js";
import { createRecallHarness, memoryEntry, type RecallTestFile } from "./recall.test-support.js";

const ROOT = resolve("/manifest-health-fixture/memory");

test("nested scan reports adapter truncation, rejected entries and directory failures", async () => {
  const nested = join(ROOT, "nested");
  const denied = join(ROOT, "denied");
  const file = join(nested, "topic.md");
  const harness = createRecallHarness(new Map([[file, { content: "alpha memory" }]]));
  harness.listings.set(ROOT, {
    entries: [
      memoryEntry(denied, "directory"),
      memoryEntry(nested, "directory"),
      memoryEntry(join(ROOT, "linked.md"), "symlink"),
      memoryEntry(join(ROOT, "readme.txt")),
      memoryEntry(join(ROOT, "MEMORY.md")),
      memoryEntry(resolve("/manifest-health-fixture/memory-state/archive/old.md")),
    ],
  });
  harness.listings.set(denied, new Error("permission denied"));
  harness.listings.set(nested, { entries: [memoryEntry(file)], truncated: true });

  const { paths, scan } = await scanMemoryCandidatePaths({
    fileSystem: harness.fileSystem,
    rootDir: ROOT,
  });
  assert.deepEqual(paths, [file]);
  assert.equal(scan.complete, false);
  assert.equal(scan.truncated, true);
  assert.equal(scan.rejected, 4);
  assert.equal(scan.failedDirectories, 1);
  assert.equal(scan.scannedDirectories, 3);
  assert.equal(scan.processedEntries, 7);
  const result = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  assert.equal(result.health?.scanLimited, true);
  assert.equal(result.scan?.failedDirectories, 1);
});

test("unknown listing coverage never reports a complete scan; legacy paths remain an array", async () => {
  const file = join(ROOT, "topic.md");
  const harness = createRecallHarness(new Map([[file, { content: "alpha memory" }]]));
  harness.listings.set(ROOT, { truncated: undefined });
  const input = { fileSystem: harness.fileSystem, rootDir: ROOT };
  const result = await scanMemoryCandidatePaths(input);
  assert.equal(result.scan.complete, false);
  assert.equal(result.scan.unknownDirectories, 1);
  assert.equal(result.scan.truncated, false);
  assert.deepEqual(await collectMemoryCandidatePaths(input), [file]);
});

test("scan enforces file, directory and entry caps with observable truncation", async () => {
  const files = new Map<string, RecallTestFile>();
  for (let index = 0; index < MEMORY_RECALL_FILE_LIMIT + 1; index++) {
    files.set(join(ROOT, `topic-${index}.md`), { content: "alpha" });
  }
  const fileHarness = createRecallHarness(files);
  const fileScan = await scanMemoryCandidatePaths({
    fileSystem: fileHarness.fileSystem,
    rootDir: ROOT,
  });
  assert.equal(fileScan.paths.length, MEMORY_RECALL_FILE_LIMIT);
  assert.equal(fileScan.scan.truncated, true);
  assert.equal(fileScan.scan.complete, false);

  const directoryHarness = createRecallHarness(new Map());
  directoryHarness.listings.set(ROOT, {
    entries: Array.from({ length: MEMORY_RECALL_DIRECTORY_LIMIT }, (_, index) =>
      memoryEntry(join(ROOT, `dir-${index}`), "directory"),
    ),
  });
  const directoryScan = await scanMemoryCandidatePaths({
    fileSystem: directoryHarness.fileSystem,
    rootDir: ROOT,
  });
  assert.equal(directoryHarness.lists.length, MEMORY_RECALL_DIRECTORY_LIMIT);
  assert.equal(directoryScan.scan.truncated, true);
  assert.equal(directoryScan.scan.complete, false);

  const entryHarness = createRecallHarness(new Map());
  entryHarness.listings.set(ROOT, {
    entries: Array.from({ length: MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT + 1 }, (_, index) =>
      memoryEntry(join(ROOT, `skip-${index}.txt`)),
    ),
  });
  const entryScan = await scanMemoryCandidatePaths({
    fileSystem: entryHarness.fileSystem,
    rootDir: ROOT,
  });
  assert.equal(entryScan.scan.processedEntries, MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT);
  assert.equal(entryScan.scan.rejected, MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT);
  assert.equal(entryScan.scan.truncated, true);
});

test("an explicit end of listing at the exact candidate cap still proves completeness", async () => {
  const files = new Map<string, RecallTestFile>();
  for (let index = 0; index < MEMORY_RECALL_FILE_LIMIT; index++) {
    files.set(join(ROOT, `topic-${index}.md`), { content: "alpha" });
  }
  const harness = createRecallHarness(files);
  const result = await scanMemoryCandidatePaths({ fileSystem: harness.fileSystem, rootDir: ROOT });
  assert.equal(result.paths.length, MEMORY_RECALL_FILE_LIMIT);
  assert.equal(result.scan.truncated, false);
  assert.equal(result.scan.complete, true);
});

test("active root enumeration cannot reach sibling memory-state, proposals or archive", async () => {
  const parent = resolve("/manifest-health-fixture");
  const harness = createRecallHarness(
    new Map([
      [join(ROOT, "active.md"), { content: "alpha active memory" }],
      [join(parent, "memory-state", "proposals", "pending.md"), { content: "alpha unapproved" }],
      [join(parent, "memory-state", "archive", "old.md"), { content: "alpha archived" }],
      [join(parent, "archive", "old.md"), { content: "alpha archived" }],
    ]),
  );
  const result = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  assert.deepEqual(
    result.results.map((entry) => entry.filename),
    ["active.md"],
  );
  assert.deepEqual(harness.lists, [ROOT]);
  assert.deepEqual(
    harness.reads.map((entry) => entry.path),
    [join(ROOT, "active.md")],
  );
});

test("nested and manifest scan cancellation is not downgraded to a partial or empty scan", async () => {
  const cancelled = Object.assign(new Error("cancelled"), { code: "cancelled" });
  const harness = createRecallHarness(new Map());
  const nested = join(ROOT, "nested");
  harness.listings.set(ROOT, { entries: [memoryEntry(nested, "directory")] });
  harness.listings.set(nested, cancelled);
  const input = { fileSystem: harness.fileSystem, rootDir: ROOT };
  await assert.rejects(scanMemoryCandidatePaths(input), (error) => error === cancelled);
  await assert.rejects(scanMemoryManifest(input), (error) => error === cancelled);
});
