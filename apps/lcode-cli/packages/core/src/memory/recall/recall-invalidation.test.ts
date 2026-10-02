import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FileSystemPort } from "@lcode/contracts";

import { ProjectMemoryRecallIndex } from "./index.js";
import {
  createRecallHarness,
  hashContent,
  memoryEntry,
  type RecallTestFile,
} from "./recall.test-support.js";

const ROOT = resolve("/recall-fixture/memory");
const FILE = join(ROOT, "preference.md");

// 外部编辑器可保留 mtime 和 size；测试不能靠修改元数据偶然触发重新读取。
test("same mtime and byte size external edits invalidate the recalled body", async () => {
  const files = new Map<string, RecallTestFile>([[FILE, { content: "alpha old", mtimeMs: 7 }]]);
  const harness = createRecallHarness(files);
  const index = new ProjectMemoryRecallIndex();
  const input = { fileSystem: harness.fileSystem, query: "alpha", rootDir: ROOT };
  await index.recall(input);
  files.set(FILE, { content: "alpha new", mtimeMs: 7 });

  const changed = await index.recall(input);
  assert.equal(changed.results[0]?.content, "alpha new");
  assert.equal(harness.reads.length, 2);
  assert.equal(changed.results[0]?.sourceHash, hashContent("alpha new"));
  await index.recall(input);
  assert.equal(
    harness.reads.length,
    3,
    "unchanged content still requires a bounded validation read",
  );
});

test("same metadata permission failures and deletion remove cached documents", async () => {
  const harness = createRecallHarness(new Map([[FILE, { content: "alpha old", mtimeMs: 7 }]]));
  const index = new ProjectMemoryRecallIndex();
  const input = { fileSystem: harness.fileSystem, query: "alpha", rootDir: ROOT };
  await index.recall(input);
  harness.files.set(FILE, { content: "alpha old", mtimeMs: 7, readable: false });

  const unreadable = await index.recall(input);
  assert.equal(unreadable.results.length, 0);
  assert.equal(unreadable.health?.failedFileCount, 1);
  assert.equal(index.size, 0);
  harness.files.set(FILE, { content: "alpha old", mtimeMs: 7 });
  await index.recall(input);
  harness.files.delete(FILE);
  const deleted = await index.recall(input);
  assert.equal(deleted.candidateCount, 0);
  assert.equal(deleted.results.length, 0);
  assert.equal(index.size, 0);
});

test("a file disappearing between listing and stat is a counted failure", async () => {
  const harness = createRecallHarness(new Map());
  harness.listings.set(ROOT, { entries: [memoryEntry(FILE)] });
  const result = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.indexedCount, 0);
  assert.equal(result.health?.failedFileCount, 1);
});

test("root changes clear prior documents even when the new directory fails or query is empty", async () => {
  const secondRoot = resolve("/other-recall-fixture/memory");
  const harness = createRecallHarness(new Map([[FILE, { content: "alpha memory" }]]));
  const index = new ProjectMemoryRecallIndex();
  await index.recall({ fileSystem: harness.fileSystem, query: "alpha", rootDir: ROOT });
  harness.listings.set(secondRoot, new Error("directory denied"));
  const second = await index.recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: secondRoot,
  });
  assert.equal(second.results.length, 0);
  assert.equal(second.scan?.failedDirectories, 1);
  assert.equal(second.scan?.complete, false);
  assert.equal(index.size, 0);
  await index.recall({ fileSystem: harness.fileSystem, query: "alpha", rootDir: ROOT });
  const empty = await index.recall({
    fileSystem: harness.fileSystem,
    query: "",
    rootDir: secondRoot,
  });
  assert.equal(empty.results.length, 0);
  assert.equal(empty.indexedCount, 0);
  assert.equal(index.size, 0);
  assert.notEqual(empty.scan?.complete, true, "an unperformed scan must not claim completeness");
});

test("a slower recall from a prior root cannot publish over the latest root", async () => {
  const secondRoot = resolve("/other-recall-fixture/memory");
  const secondFile = join(secondRoot, "second.md");
  const harness = createRecallHarness(
    new Map([
      [FILE, { content: "alpha memory" }],
      [secondFile, { content: "beta memory" }],
      [join(secondRoot, "other.md"), { content: "unrelated content" }],
    ]),
  );
  const read = harness.fileSystem.readTextFile.bind(harness.fileSystem);
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  harness.fileSystem.readTextFile = async (request, options) => {
    if (request.path === FILE) {
      started();
      await blocked;
    }
    return read(request, options);
  };
  const index = new ProjectMemoryRecallIndex();
  const first = index.recall({ fileSystem: harness.fileSystem, query: "alpha", rootDir: ROOT });
  await reading;
  const second = await index.recall({
    fileSystem: harness.fileSystem,
    query: "beta",
    rootDir: secondRoot,
  });
  assert.equal(second.results[0]?.filePath, secondFile);
  release();
  const prior = await first;
  assert.equal(prior.results[0]?.filePath, FILE, "each caller ranks its own verified snapshot");
  assert.equal(index.size, 2);
  const noQuery = await index.recall({
    fileSystem: harness.fileSystem,
    query: "",
    rootDir: secondRoot,
  });
  assert.equal(noQuery.indexedCount, 2);
});

test("recall propagates cancellation instead of reporting it as an unreadable file", async () => {
  const harness = createRecallHarness(new Map([[FILE, { content: "alpha memory" }]]));
  const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });
  harness.fileSystem.readTextFile = async () => {
    throw cancelled;
  };
  await assert.rejects(
    new ProjectMemoryRecallIndex().recall({
      fileSystem: harness.fileSystem,
      query: "alpha",
      rootDir: ROOT,
    }),
    (error) => error === cancelled,
  );

  const controller = new AbortController();
  controller.abort(cancelled);
  const untouched = {
    async listDirectory() {
      assert.fail("pre-aborted recall must not start IO");
    },
  } as unknown as FileSystemPort;
  await assert.rejects(
    new ProjectMemoryRecallIndex().recall({
      fileSystem: untouched,
      query: "",
      rootDir: ROOT,
      signal: controller.signal,
    }),
    (error) => error === cancelled,
  );
});
