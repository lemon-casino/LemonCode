import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProjectMemoryReviewItemSchema } from "@lcode/contracts";
import { NodeFileSystemAdapter } from "./index.js";
import {
  digest,
  hasCode,
  memoryFixture,
  reviewDraft,
  seedPrepared,
} from "./project-memory.test-support.js";

const itemDigest = (item: unknown) =>
  digest(JSON.stringify(ProjectMemoryReviewItemSchema.parse(item)));

test("reviews persist separately, validate approval, and apply idempotently from journal", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const proposal = await memory.saveReview({ rootDir, draft: reviewDraft() });
  const path = join(rootDir, "fact.md");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal((await memory.listReviews(rootDir)).length, 1);
  assert.deepEqual(await memory.readReview({ rootDir, proposalId: proposal.id }), proposal);
  const input = {
    rootDir,
    proposalId: proposal.id,
    revision: proposal.revision,
    itemId: "item-0001",
    expectedItemHash: itemDigest(proposal.draft.items[0]),
    expectedSourceHashes: [],
  };
  await assert.rejects(memory.applyReview({ ...input, revision: 999 }), hasCode("stale_write"));
  await assert.rejects(
    memory.applyReview({ ...input, expectedItemHash: digest("not approved") }),
    hasCode("stale_write"),
  );
  await assert.rejects(
    memory.applyReview({ ...input, itemId: "item-missing" }),
    hasCode("not_found"),
  );
  await assert.rejects(
    memory.applyReview(input, { signal: AbortSignal.abort() }),
    hasCode("cancelled"),
  );
  const other = new NodeFileSystemAdapter();
  await other.projectMemory.registerRoot(rootDir);
  const [applied, duplicate] = await Promise.all([
    memory.applyReview(input),
    other.projectMemory.applyReview(input),
  ]);
  assert.equal(applied.id, duplicate.id);
  assert.equal(applied.status, "committed");
  assert.equal(applied.proposalId, proposal.id);
  assert.equal(applied.proposalItemId, input.itemId);
  assert.equal(await readFile(path, "utf8"), proposal.draft.items[0]!.content);
  assert.equal((await memory.listChanges(rootDir)).length, 1);
  const projected = await memory.readReview({ rootDir, proposalId: proposal.id });
  assert.equal(projected.appliedItems[input.itemId], applied.id);
  const durable = JSON.parse(
    await readFile(join(stateDir, "reviews", `${proposal.id}.json`), "utf8"),
  );
  assert.deepEqual(
    durable.review.appliedItems,
    {},
    "proposal must not become a second mutable commit truth",
  );
  await writeFile(path, "external edit after application");
  assert.equal((await memory.applyReview(input)).id, applied.id);
  assert.equal(await readFile(path, "utf8"), "external edit after application");
  durable.review.draft.items[0].content = "tampered approval";
  await writeFile(join(stateDir, "reviews", `${proposal.id}.json`), JSON.stringify(durable));
  await assert.rejects(memory.applyReview(input), hasCode("stale_write"));
  assert.equal((await adapter.readTextFile({ path })).content, "external edit after application");
});

test("schema-valid item identifiers never collide with object prototype properties", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  const draft = reviewDraft();
  draft.items[0]!.id = "constructor";
  const proposal = await memory.saveReview({ rootDir, draft });
  const applied = await memory.applyReview({
    rootDir,
    proposalId: proposal.id,
    revision: proposal.revision,
    itemId: "constructor",
    expectedItemHash: itemDigest(proposal.draft.items[0]),
    expectedSourceHashes: [],
  });
  const projected = await memory.readReview({ rootDir, proposalId: proposal.id });
  assert.equal(projected.appliedItems["constructor"], applied.id);
  assert.equal(Object.hasOwn(projected.appliedItems, "constructor"), true);
});

test("an interrupted review apply recovers its proposal association instead of rewriting", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const proposal = await memory.saveReview({ rootDir, draft: reviewDraft("approved") });
  await seedPrepared({
    rootDir,
    stateDir,
    id: "apply-interrupted",
    fileName: "fact.md",
    before: null,
    after: "approved",
    proposalId: proposal.id,
    proposalItemId: "item-0001",
  });
  await writeFile(join(rootDir, "fact.md"), "approved");
  const applied = await memory.applyReview({
    rootDir,
    proposalId: proposal.id,
    revision: proposal.revision,
    itemId: "item-0001",
    expectedItemHash: itemDigest(proposal.draft.items[0]),
    expectedSourceHashes: [],
  });
  assert.equal(applied.id, "apply-interrupted");
  assert.equal(applied.status, "committed");
  assert.equal((await memory.listChanges(rootDir)).length, 1);
  assert.equal(
    (await memory.readReview({ rootDir, proposalId: proposal.id })).appliedItems["item-0001"],
    applied.id,
  );
});

test("review target conflicts and foreign-root envelopes are rejected without writes", async (t) => {
  const a = await memoryFixture(t);
  const b = await memoryFixture(t);
  const proposal = await a.memory.saveReview({
    rootDir: a.rootDir,
    draft: reviewDraft("proposal", digest("original")),
  });
  await writeFile(join(a.rootDir, "fact.md"), "external");
  await assert.rejects(
    a.memory.applyReview({
      rootDir: a.rootDir,
      proposalId: proposal.id,
      revision: proposal.revision,
      itemId: "item-0001",
      expectedItemHash: itemDigest(proposal.draft.items[0]),
      expectedSourceHashes: [],
    }),
    hasCode("stale_write"),
  );
  assert.equal(await readFile(join(a.rootDir, "fact.md"), "utf8"), "external");
  assert.deepEqual(await a.memory.listChanges(a.rootDir), []);
  await writeFile(
    join(b.stateDir, "reviews", `${proposal.id}.json`),
    await readFile(join(a.stateDir, "reviews", `${proposal.id}.json`)),
  );
  await assert.rejects(
    b.memory.readReview({ rootDir: b.rootDir, proposalId: proposal.id }),
    hasCode("invalid_path"),
  );
});
