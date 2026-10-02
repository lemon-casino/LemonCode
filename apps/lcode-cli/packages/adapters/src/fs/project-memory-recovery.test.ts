import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "./index.js";
import { digest, hasCode, memoryFixture, seedPrepared } from "./project-memory.test-support.js";

test("prepared journal recovery distinguishes committed, not committed and divergent states", async (t) => {
  const { rootDir, stateDir, memory, adapter } = await memoryFixture(t);
  const states = [
    { id: "recover-after", fileName: "after.md", current: "after", status: "committed" },
    { id: "recover-before", fileName: "before.md", current: "before", status: "not-committed" },
    {
      id: "recover-diverge",
      fileName: "diverge.md",
      current: "external",
      status: "recovery-required",
    },
  ];
  for (const fixture of states) {
    await seedPrepared({ rootDir, stateDir, ...fixture, before: "before", after: "after" });
    await writeFile(join(rootDir, fixture.fileName), fixture.current);
  }
  await seedPrepared({
    rootDir,
    stateDir,
    id: "recover-missing",
    fileName: "absent.md",
    before: null,
    after: "after",
  });
  const changes = await memory.listChanges(rootDir);
  for (const fixture of states) {
    assert.equal(changes.find((change) => change.id === fixture.id)?.status, fixture.status);
    assert.equal(await readFile(join(rootDir, fixture.fileName), "utf8"), fixture.current);
  }
  assert.equal(changes.find((change) => change.id === "recover-missing")?.status, "not-committed");
  await assert.rejects(
    adapter.writeTextFile({
      path: join(rootDir, "another.md"),
      content: "blocked",
      expectedMissing: true,
    }),
    hasCode("stale_write"),
  );
  assert.deepEqual(await memory.listChanges(rootDir), changes);
});

test("undo is replace-only and checks both approved preimage and current after hash", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "fact.md");
  const original = "original\r\nbytes\r\n";
  const created = await adapter.writeTextFile({ path, content: original, expectedMissing: true });
  const createChange = (await memory.listChanges(rootDir))[0]!;
  await assert.rejects(
    memory.previewUndo({ rootDir, changeId: createChange.id }),
    hasCode("unsupported"),
  );
  await adapter.writeTextFile({ path, content: "replacement", expectedRevision: created.revision });
  const change = (await memory.listChanges(rootDir)).find((entry) => entry.beforeHash !== null)!;
  const preview = await memory.previewUndo({ rootDir, changeId: change.id });
  assert.equal(preview.content, original);
  const input = {
    rootDir,
    changeId: change.id,
    expectedHash: change.afterHash,
    expectedBeforeHash: digest(original),
  };
  await assert.rejects(
    memory.undoChange({ ...input, expectedBeforeHash: digest("unapproved") }),
    hasCode("stale_write"),
  );
  await writeFile(path, "external edit");
  await assert.rejects(memory.undoChange(input), hasCode("stale_write"));
  assert.equal(await readFile(path, "utf8"), "external edit");
  await writeFile(path, "replacement");
  await writeFile(join(stateDir, "preimages", `${change.id}.bin`), "forged preimage");
  await assert.rejects(memory.undoChange(input), hasCode("stale_write"));
  await writeFile(join(stateDir, "preimages", `${change.id}.bin`), original);
  const undone = await memory.undoChange(input);
  assert.equal(undone.undoOf, change.id);
  assert.equal(undone.status, "committed");
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(memory.undoChange(input), hasCode("stale_write"));
});

test("new adapters recover the same durable journal without a second mutable state", async (t) => {
  const { rootDir, stateDir } = await memoryFixture(t);
  await seedPrepared({
    rootDir,
    stateDir,
    id: "recover-restart",
    fileName: "fact.md",
    before: "before",
    after: "after",
  });
  await writeFile(join(rootDir, "fact.md"), "after");
  const restarted = new NodeFileSystemAdapter();
  await restarted.projectMemory.registerRoot(rootDir);
  assert.equal((await restarted.projectMemory.listChanges(rootDir))[0]?.status, "committed");
});
