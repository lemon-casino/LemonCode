import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProjectMemoryReviewItemSchema } from "@lcode/contracts";
import { NodeFileSystemAdapter } from "./index.js";
import { digest, hasCode, memoryFixture, reviewDraft } from "./project-memory.test-support.js";

// prepared 首次发布使用排他 link；故障只命中 target 发布后的 committed JSON rename。
process.env.LCODE_E2E_FS_FAULTS_ALLOW = "1";
process.env.LCODE_E2E_FS_FAULTS = JSON.stringify([
  {
    id: "commit-journal-denied",
    code: "EACCES",
    operations: ["rename"],
    pathIncludes: "/memory-state/journal/",
    maxMatches: 1,
  },
]);

test("commit-marker failure preserves prepared proposal association and retry never rewrites target", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const proposal = await memory.saveReview({
    rootDir,
    draft: reviewDraft("committed before marker"),
  });
  const input = {
    rootDir,
    proposalId: proposal.id,
    revision: proposal.revision,
    itemId: "item-0001",
    expectedItemHash: digest(
      JSON.stringify(ProjectMemoryReviewItemSchema.parse(proposal.draft.items[0])),
    ),
    expectedSourceHashes: [],
  };
  await assert.rejects(memory.applyReview(input), hasCode("permission_denied"));
  const path = join(rootDir, "fact.md");
  assert.equal(await readFile(path, "utf8"), "committed before marker");
  const published = await stat(path);
  const [name] = await readdir(join(stateDir, "journal"));
  const prepared = JSON.parse(await readFile(join(stateDir, "journal", name!), "utf8"));
  assert.equal(prepared.change.status, "prepared");
  assert.equal(prepared.change.proposalId, proposal.id);
  const restarted = new NodeFileSystemAdapter();
  await restarted.projectMemory.registerRoot(rootDir);
  const result = await restarted.projectMemory.applyReview(input);
  assert.equal(result.id, prepared.change.id);
  assert.equal(result.status, "committed");
  assert.equal((await stat(path)).ino, published.ino, "retry must not publish a replacement inode");
  assert.equal((await stat(path)).mtimeMs, published.mtimeMs);
  assert.equal((await restarted.projectMemory.listChanges(rootDir)).length, 1);
  const review = JSON.parse(
    await readFile(join(stateDir, "reviews", `${proposal.id}.json`), "utf8"),
  );
  assert.deepEqual(review.review.appliedItems, {});
});
