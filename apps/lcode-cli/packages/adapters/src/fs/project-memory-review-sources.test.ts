import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  PROJECT_MEMORY_REVIEW_ITEM_LIMIT,
  ProjectMemoryReviewItemSchema,
  type ProjectMemoryPort,
} from "@lcode/contracts";
import { NodeFileSystemAdapter } from "./index.js";
import { MemoryJournal } from "./project-memory-journal.js";
import { digest, hasCode, memoryFixture, reviewDraft } from "./project-memory.test-support.js";

async function sourceFixture(t: TestContext, existingTarget = false) {
  const fixture = await memoryFixture(t);
  const sourcePath = join(fixture.rootDir, "source.md");
  const sourceContent = "frozen\r\nsource evidence\r\n";
  const source = await fixture.adapter.writeTextFile({
    path: sourcePath,
    content: sourceContent,
    expectedMissing: true,
  });
  const draft = reviewDraft("derived fact", existingTarget ? digest("old target") : null);
  draft.sources.push({
    id: "memory-source",
    kind: "memory",
    reference: "source.md",
    revision: "scope-and-material-fingerprint",
  });
  draft.items[0]!.sourceIds.push("memory-source");
  if (existingTarget)
    await fixture.adapter.writeTextFile({
      path: join(fixture.rootDir, "fact.md"),
      content: "old target",
      expectedMissing: true,
    });
  const proposal = await fixture.memory.saveReview({ rootDir: fixture.rootDir, draft });
  const input: Parameters<ProjectMemoryPort["applyReview"]>[0] = {
    rootDir: fixture.rootDir,
    proposalId: proposal.id,
    revision: proposal.revision,
    itemId: "item-0001",
    expectedItemHash: digest(
      JSON.stringify(ProjectMemoryReviewItemSchema.parse(proposal.draft.items[0])),
    ),
    expectedSourceHashes: [{ fileName: "source.md", hash: source.revision!.hash! }],
  };
  return { ...fixture, sourcePath, sourceContent, source, input };
}

for (const sourceChanged of [true, false]) {
  test(`two adapters ${sourceChanged ? "reject source changed" : "accept unchanged source"} while apply waits behind a root writer`, async (t) => {
    const fixture = await sourceFixture(t);
    const reviewer = new NodeFileSystemAdapter();
    await reviewer.projectMemory.registerRoot(fixture.rootDir);
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const applyEntered = Promise.withResolvers<void>();
    t.after(() => releaseWriter.resolve());
    const originalCommit = MemoryJournal.prototype.commit;
    const writerFile = sourceChanged ? "source.md" : "unrelated.md";
    t.mock.method(
      MemoryJournal.prototype,
      "commit",
      async function (this: MemoryJournal, ...args: Parameters<MemoryJournal["commit"]>) {
        if (args[0].fileName === writerFile) {
          writerEntered.resolve();
          await releaseWriter.promise;
        }
        return originalCommit.apply(this, args);
      },
    );
    // 只观察锁入口，不伪造端口/磁盘；第一个真实adapter仍持有root锁直到显式释放。
    const lockEntry = reviewer.projectMemory as unknown as {
      locked: (...args: unknown[]) => Promise<unknown>;
    };
    const originalLocked = lockEntry.locked;
    t.mock.method(lockEntry, "locked", function (this: typeof lockEntry, ...args: unknown[]) {
      const result = originalLocked.apply(this, args);
      applyEntered.resolve();
      return result;
    });
    const writing = fixture.adapter.writeTextFile({
      path: join(fixture.rootDir, writerFile),
      content: "corrected evidence",
      ...(sourceChanged
        ? { expectedRevision: fixture.source.revision }
        : { expectedMissing: true }),
    });
    await writerEntered.promise;
    const applying = reviewer.projectMemory.applyReview(fixture.input);
    const outcome = sourceChanged ? assert.rejects(applying, hasCode("stale_write")) : applying;
    await applyEntered.promise;
    releaseWriter.resolve();
    await writing;
    await outcome;
    if (sourceChanged) {
      await assert.rejects(readFile(join(fixture.rootDir, "fact.md")), { code: "ENOENT" });
      assert.equal(await readFile(fixture.sourcePath, "utf8"), "corrected evidence");
      assert.equal(
        (await fixture.memory.listChanges(fixture.rootDir)).some(
          (change) => change.proposalId === fixture.input.proposalId,
        ),
        false,
      );
    } else {
      assert.equal((await applying).status, "committed");
      assert.equal(await readFile(join(fixture.rootDir, "fact.md"), "utf8"), "derived fact");
      assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.sourceContent);
    }
  });
}

test("source hash set must exactly cover the item's memory references and reject duplicates or invalid paths", async (t) => {
  const { memory, input, rootDir } = await sourceFixture(t);
  const source = input.expectedSourceHashes[0]!;
  const cases: Array<{ hashes: unknown; code: string }> = [
    { hashes: undefined, code: "stale_write" },
    { hashes: [], code: "stale_write" },
    { hashes: [source, source], code: "stale_write" },
    { hashes: [{ fileName: "other.md", hash: source.hash }], code: "stale_write" },
    { hashes: [source, { fileName: "unrelated.md", hash: source.hash }], code: "stale_write" },
    { hashes: [{ fileName: "../source.md", hash: source.hash }], code: "invalid_path" },
    { hashes: [{ fileName: join(rootDir, "source.md"), hash: source.hash }], code: "invalid_path" },
    { hashes: [{ fileName: "source.txt", hash: source.hash }], code: "invalid_path" },
    { hashes: [{ fileName: "source.md", hash: "mtime:10:size:10" }], code: "stale_write" },
    {
      hashes: Array.from({ length: PROJECT_MEMORY_REVIEW_ITEM_LIMIT + 1 }, (_, index) => ({
        fileName: `source-${index}.md`,
        hash: source.hash,
      })),
      code: "too_large",
    },
  ];
  for (const { hashes, code } of cases) {
    await assert.rejects(
      memory.applyReview({
        ...input,
        expectedSourceHashes: hashes as typeof input.expectedSourceHashes,
      }),
      hasCode(code),
    );
  }
  await assert.rejects(readFile(join(rootDir, "fact.md")), { code: "ENOENT" });
});

test("full raw-byte source hashes and current target preconditions are both mandatory", async (t) => {
  const { memory, input, rootDir, sourceContent } = await sourceFixture(t, true);
  await assert.rejects(
    memory.applyReview({
      ...input,
      expectedSourceHashes: [
        { fileName: "source.md", hash: digest(sourceContent.replaceAll("\r\n", "\n")) },
      ],
    }),
    hasCode("stale_write"),
  );
  await writeFile(join(rootDir, "fact.md"), "external target update");
  await assert.rejects(memory.applyReview(input), hasCode("stale_write"));
  assert.equal(await readFile(join(rootDir, "fact.md"), "utf8"), "external target update");
});

test("missing source or a source replaced with a symlink never creates derived memory", async (t) => {
  const { base, memory, input, rootDir, sourcePath, sourceContent } = await sourceFixture(t);
  await rm(sourcePath);
  await assert.rejects(memory.applyReview(input), hasCode("stale_write"));
  const external = join(base, "external.md");
  await writeFile(external, sourceContent);
  try {
    await symlink(external, sourcePath, "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.diagnostic("File symlinks unavailable; missing-source rejection verified");
      return;
    }
    throw error;
  }
  await assert.rejects(memory.applyReview(input), hasCode("invalid_path"));
  await assert.rejects(readFile(join(rootDir, "fact.md")), { code: "ENOENT" });
});

test("idempotent replay does not revalidate a source already replaced by its own committed item", async (t) => {
  const { memory, rootDir, source } = await sourceFixture(t);
  const draft = reviewDraft("new source fact", source.revision!.hash!);
  draft.sources = [
    {
      id: "memory-source",
      kind: "memory",
      reference: "source.md",
      revision: "frozen-source-scope",
    },
  ];
  draft.items[0]!.fileName = "source.md";
  draft.items[0]!.sourceIds = ["memory-source"];
  const proposal = await memory.saveReview({ rootDir, draft });
  const input = {
    rootDir,
    proposalId: proposal.id,
    revision: proposal.revision,
    itemId: "item-0001",
    expectedItemHash: digest(
      JSON.stringify(ProjectMemoryReviewItemSchema.parse(proposal.draft.items[0])),
    ),
    expectedSourceHashes: [{ fileName: "source.md", hash: source.revision!.hash! }],
  };
  const committed = await memory.applyReview(input);
  assert.equal((await memory.applyReview(input)).id, committed.id);
  assert.equal(await readFile(join(rootDir, "source.md"), "utf8"), "new source fact");
});
