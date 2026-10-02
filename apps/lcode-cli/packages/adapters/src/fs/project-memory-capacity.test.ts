import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_PREIMAGES_MAX_BYTES,
  PROJECT_MEMORY_RECORD_LIMIT,
} from "@lcode/contracts";
import {
  digest,
  hasCode,
  memoryFixture,
  reviewDraft,
  seedPrepared,
} from "./project-memory.test-support.js";

test("capacity inspection reports available storage without changing user memory", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  assert.deepEqual(await memory.inspectCapacity(rootDir), { available: true });
  assert.deepEqual(await readdir(rootDir), []);
  assert.deepEqual(await memory.listChanges(rootDir), []);
  await assert.rejects(
    memory.inspectCapacity(rootDir, { signal: AbortSignal.abort() }),
    hasCode("cancelled"),
  );
});

for (const directory of ["journal", "reviews"] as const) {
  test(`capacity inspection returns ${directory === "journal" ? "history-full" : "reviews-full"} without deleting full records`, async (t) => {
    const { rootDir, stateDir, memory } = await memoryFixture(t);
    for (let index = 0; index < PROJECT_MEMORY_RECORD_LIMIT; index += 1) {
      const id = `capacity-${String(index).padStart(4, "0")}`;
      const value =
        directory === "journal"
          ? {
              change: {
                schemaVersion: 1,
                id,
                createdAt: index,
                fileName: "fact.md",
                beforeHash: null,
                afterHash: digest("content"),
                status: "not-committed",
              },
            }
          : {
              review: {
                schemaVersion: 1,
                id,
                createdAt: index,
                revision: 1,
                draft: reviewDraft(),
                appliedItems: {},
              },
            };
      await writeFile(
        join(stateDir, directory, `${id}.json`),
        JSON.stringify({ schemaVersion: 1, rootDir, ...value }),
      );
    }
    assert.deepEqual(await memory.inspectCapacity(rootDir), {
      available: false,
      reason: directory === "journal" ? "history-full" : "reviews-full",
    });
    assert.equal((await readdir(join(stateDir, directory))).length, PROJECT_MEMORY_RECORD_LIMIT);
    await writeFile(
      join(stateDir, directory, "capacity-0000.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    await assert.rejects(memory.inspectCapacity(rootDir), hasCode("io_error"));
  });
}

test("capacity inspection reserves one maximum-size preimage and reports full before the hard limit", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const bytes = Buffer.alloc(PROJECT_MEMORY_FILE_MAX_BYTES, 120);
  const count = PROJECT_MEMORY_PREIMAGES_MAX_BYTES / bytes.length - 1;
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(stateDir, "preimages", `capacity-${String(index).padStart(4, "0")}.bin`),
      bytes,
    );
  }
  assert.deepEqual(await memory.inspectCapacity(rootDir), { available: true });
  await writeFile(join(stateDir, "preimages", "capacity-extra.bin"), "x");
  assert.deepEqual(await memory.inspectCapacity(rootDir), {
    available: false,
    reason: "preimages-full",
  });
  await writeFile(join(stateDir, "preimages", "capacity-extra.bin"), bytes);
  assert.deepEqual(await memory.inspectCapacity(rootDir), {
    available: false,
    reason: "preimages-full",
  });
  assert.equal((await readdir(join(stateDir, "preimages"))).length, count + 1);
});

test("capacity inspection reuses deterministic recovery but does not write through divergent state", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  await seedPrepared({
    rootDir,
    stateDir,
    id: "capacity-prepared",
    fileName: "fact.md",
    before: null,
    after: "after",
  });
  assert.deepEqual(await memory.inspectCapacity(rootDir), { available: true });
  assert.equal((await memory.listChanges(rootDir))[0]?.status, "not-committed");
  await seedPrepared({
    rootDir,
    stateDir,
    id: "capacity-diverged",
    fileName: "fact.md",
    before: "before",
    after: "after",
  });
  await writeFile(join(rootDir, "fact.md"), "external");
  assert.deepEqual(await memory.inspectCapacity(rootDir), {
    available: false,
    reason: "recovery-required",
  });
  assert.equal(await readFile(join(rootDir, "fact.md"), "utf8"), "external");
});
