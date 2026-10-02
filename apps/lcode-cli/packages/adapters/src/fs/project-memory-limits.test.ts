import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_PREIMAGES_MAX_BYTES,
  PROJECT_MEMORY_RECORD_LIMIT,
} from "@lcode/contracts";
import {
  hasCode,
  memoryFixture,
  reviewDraft,
  seedPrepared,
} from "./project-memory.test-support.js";

test("preimage total byte budget rejects writes before creating a journal or deleting history", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const bytes = Buffer.alloc(PROJECT_MEMORY_FILE_MAX_BYTES, 120);
  const count = PROJECT_MEMORY_PREIMAGES_MAX_BYTES / bytes.length;
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(stateDir, "preimages", `orphan-${String(index).padStart(4, "0")}.bin`),
      bytes,
      { mode: 0o600 },
    );
  }
  const path = join(rootDir, "fact.md");
  await writeFile(path, "original");
  const current = await adapter.readTextFile({ path });
  await assert.rejects(
    adapter.writeTextFile({ path, content: "replacement", expectedRevision: current.revision }),
    hasCode("too_large"),
  );
  assert.equal(await readFile(path, "utf8"), "original");
  assert.deepEqual(await memory.listChanges(rootDir), []);
  assert.equal((await readdir(join(stateDir, "preimages"))).length, count);
  await writeFile(join(stateDir, "preimages", "orphan-over.bin"), "one extra byte");
  await assert.rejects(memory.listChanges(rootDir), hasCode("too_large"));
});

test("the 100-entry journal limit blocks before touching target content", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  for (let index = 0; index < PROJECT_MEMORY_RECORD_LIMIT; index += 1) {
    const change = await seedPrepared({
      rootDir,
      stateDir,
      id: `limited-${String(index).padStart(4, "0")}`,
      fileName: "absent.md",
      before: null,
      after: "not committed",
    });
    await writeFile(
      join(stateDir, "journal", `${change.id}.json`),
      JSON.stringify({ schemaVersion: 1, rootDir, change: { ...change, status: "not-committed" } }),
    );
  }
  const path = join(rootDir, "blocked.md");
  await assert.rejects(
    adapter.writeTextFile({ path, content: "new", expectedMissing: true }),
    hasCode("too_large"),
  );
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal((await memory.listChanges(rootDir)).length, PROJECT_MEMORY_RECORD_LIMIT);
});

test("sidecar files and subdirectories never follow injected symlinks or foreign schemas", async (t) => {
  const { rootDir, stateDir, base, memory } = await memoryFixture(t);
  const proposal = await memory.saveReview({ rootDir, draft: reviewDraft() });
  const path = join(stateDir, "reviews", `${proposal.id}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...record, unexpected: "field" }));
  await assert.rejects(
    memory.readReview({ rootDir, proposalId: proposal.id }),
    hasCode("io_error"),
  );
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(
    memory.readReview({ rootDir, proposalId: "../owner" }),
    hasCode("invalid_path"),
  );
  const outside = join(base, "outside-journal");
  await mkdir(outside);
  await symlink(
    outside,
    join(stateDir, "journal", "linked-data"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(memory.listChanges(rootDir), hasCode("invalid_path"));
  assert.deepEqual(await readdir(outside), []);
});

test("nested managed writes create only verified directories and store staging outside recall root", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "nested", "deeper", "fact.md");
  await adapter.writeTextFile({
    path,
    content: "nested",
    expectedMissing: true,
    createParents: true,
  });
  assert.equal(await readFile(path, "utf8"), "nested");
  assert.deepEqual(await readdir(join(stateDir, "staging")), []);
  assert.equal((await memory.listChanges(rootDir))[0]?.fileName, "nested/deeper/fact.md");
});
