import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProjectMemoryReviewItemSchema } from "@lcode/contracts";
import { NodeFileSystemAdapter } from "./index.js";
import { strictAtomicWrite } from "./project-memory-io.js";
import { digest, hasCode, memoryFixture, reviewDraft } from "./project-memory.test-support.js";

// 故障器首次使用时缓存环境规则；本测试文件拥有独立 node:test worker。
process.env.LCODE_E2E_FS_FAULTS_ALLOW = "1";
process.env.LCODE_E2E_FS_FAULTS = JSON.stringify([
  {
    id: "managed-rename-denied",
    code: "EACCES",
    operations: ["rename"],
    pathEndsWith: "rename-failure.md",
    maxMatches: 1,
  },
]);

test("failed Windows-style rename keeps old bytes and records not-committed without truncation", async (t) => {
  const { rootDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "rename-failure.md");
  const initial = await adapter.writeTextFile({ path, content: "retained", expectedMissing: true });
  await assert.rejects(
    adapter.writeTextFile({
      path,
      content: "must never truncate",
      expectedRevision: initial.revision,
    }),
    hasCode("permission_denied"),
  );
  assert.equal(await readFile(path, "utf8"), "retained");
  const changes = await memory.listChanges(rootDir);
  assert.equal(changes.filter((change) => change.status === "not-committed").length, 1);
  assert.equal(changes.filter((change) => change.status === "committed").length, 1);
  assert.deepEqual(
    (await readdir(rootDir)).filter((name) => name.startsWith(".lcode-memory-")),
    [],
  );
});

test("strict creation never clobbers a file appearing between validation and publication", async (t) => {
  const { rootDir } = await memoryFixture(t);
  const path = join(rootDir, "raced.md");
  await assert.rejects(
    strictAtomicWrite(path, Buffer.from("writer"), {
      expectedMissing: true,
      beforePublish: async () => {
        await writeFile(path, "external creation", { flag: "wx" });
      },
    }),
    hasCode("stale_write"),
  );
  assert.equal(await readFile(path, "utf8"), "external creation");
});

test("cancelling before atomic publication preserves bytes and removes only own temporary file", async (t) => {
  const { rootDir } = await memoryFixture(t);
  const path = join(rootDir, "cancel.md");
  await writeFile(path, "retained");
  const controller = new AbortController();
  await assert.rejects(
    strictAtomicWrite(path, Buffer.from("cancelled"), {
      signal: controller.signal,
      beforePublish: async () => {
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(await readFile(path, "utf8"), "retained");
  assert.deepEqual(
    (await readdir(rootDir)).filter((name) => name.startsWith(".lcode-memory-")),
    [],
  );
});

test("journal-only review recovery remains idempotent after process-local adapter state is lost", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const review = await memory.saveReview({ rootDir, draft: reviewDraft("applied") });
  const input = {
    rootDir,
    proposalId: review.id,
    revision: review.revision,
    itemId: "item-0001",
    expectedItemHash: digest(
      JSON.stringify(ProjectMemoryReviewItemSchema.parse(review.draft.items[0])),
    ),
    expectedSourceHashes: [],
  };
  const change = await memory.applyReview(input);
  const journalPath = join(stateDir, "journal", `${change.id}.json`);
  const record = JSON.parse(await readFile(journalPath, "utf8"));
  record.change.status = "prepared";
  await writeFile(journalPath, JSON.stringify(record));
  const restarted = new NodeFileSystemAdapter();
  await restarted.projectMemory.registerRoot(rootDir);
  const recovered = await restarted.projectMemory.applyReview(input);
  assert.equal(recovered.id, change.id);
  assert.equal(recovered.status, "committed");
  assert.equal((await restarted.projectMemory.listChanges(rootDir)).length, 1);
  assert.equal(await readFile(join(rootDir, "fact.md"), "utf8"), "applied");
});
