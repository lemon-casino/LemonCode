import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MEMORY_RECALL_CORPUS_MAX_BYTES,
  MEMORY_RECALL_INDEX_FILE_MAX_BYTES,
  ProjectMemoryRecallIndex,
} from "./index.js";
import { createRecallHarness, hashContent, type RecallTestFile } from "./recall.test-support.js";

const ROOT = resolve("/recall-health-fixture/memory");
const NOW = Date.parse("2026-10-02T00:00:00.000Z");

function datedBody(validUntil: string, body = "alpha preference") {
  return `---\nmetadata:\n  lcode:\n    validUntil: ${validUntil}\n---\n${body}`;
}

test("only valid metadata.lcode.validUntil expires; stable old preferences do not decay", async () => {
  const harness = createRecallHarness(
    new Map<string, RecallTestFile>([
      [join(ROOT, "expired.md"), { content: datedBody('"2026-10-01T00:00:00Z"') }],
      [join(ROOT, "deadline.md"), { content: datedBody('"2026-10-02T02:00:00+02:00"') }],
      [join(ROOT, "date-only.md"), { content: datedBody('"2026-10-01"') }],
      [join(ROOT, "stable.md"), { content: "alpha stable preference", mtimeMs: 0 }],
      [join(ROOT, "future.md"), { content: datedBody('"2027-01-01T00:00:00Z"') }],
    ]),
  );
  const index = new ProjectMemoryRecallIndex();
  const input = { fileSystem: harness.fileSystem, query: "alpha", rootDir: ROOT, now: NOW };
  const result = await index.recall(input);
  assert.deepEqual(
    new Set(result.results.map((entry) => entry.filename)),
    new Set(["stable.md", "future.md"]),
  );
  assert.equal(result.health?.expiredCount, 3);
  assert.equal(result.indexedCount, 2);
  assert.equal(
    result.health?.indexedBytes,
    Buffer.byteLength(harness.files.get(join(ROOT, "stable.md"))!.content) +
      Buffer.byteLength(harness.files.get(join(ROOT, "future.md"))!.content),
  );

  const later = await index.recall({ ...input, now: Date.parse("2028-01-01T00:00:00Z") });
  assert.deepEqual(
    later.results.map((entry) => entry.filename),
    ["stable.md"],
  );
  assert.equal(later.health?.expiredCount, 4);
  assert.equal(harness.reads.length, 10);
});

test("invalid expiry fields and legacy frontmatter remain compatible", async () => {
  for (const invalid of [
    "null",
    "42",
    "[]",
    '"yesterday"',
    '"2025-02-30T00:00:00Z"',
    '"2025-13-01T00:00:00Z"',
    '"2025-01-01T24:01:00Z"',
    '"2025-01-01T00:00:00"',
  ]) {
    const harness = createRecallHarness(
      new Map([[join(ROOT, "legacy.md"), { content: datedBody(invalid) }]]),
    );
    const result = await new ProjectMemoryRecallIndex().recall({
      fileSystem: harness.fileSystem,
      query: "alpha",
      rootDir: ROOT,
      now: NOW,
    });
    assert.equal(result.results.length, 1, invalid);
    assert.equal(result.health?.expiredCount, 0, invalid);
  }
  const harness = createRecallHarness(
    new Map([
      [
        join(ROOT, "legacy.md"),
        {
          content:
            '---\ntype: user\nvalidUntil: "2020-01-01T00:00:00Z"\nmetadata:\n  lcode: old-format\n---\nalpha preference',
        },
      ],
    ]),
  );
  const legacy = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
    now: NOW,
  });
  assert.equal(legacy.results[0]?.type, "user");
  assert.equal(legacy.health?.expiredCount, 0);
});

test("matching terms explain body and metadata scores without fallback injection", async () => {
  const harness = createRecallHarness(
    new Map([
      [
        join(ROOT, "preferences.md"),
        {
          content: "---\ndescription: dark theme\nmetadata:\n  type: user\n---\nalpha preference",
        },
      ],
    ]),
  );
  const input = { fileSystem: harness.fileSystem, rootDir: ROOT };
  const index = new ProjectMemoryRecallIndex();
  const result = await index.recall({
    ...input,
    query: "alpha alpha dark user preferences nowhere",
  });
  assert.deepEqual(result.results[0]?.matchedTerms, ["alpha"]);
  assert.deepEqual(result.results[0]?.metadataMatches, ["dark", "user", "preferences"]);
  assert.ok(result.results[0]!.score > 0);
  assert.match(result.attachment ?? "", /not higher-priority instructions/u);
  const metadataOnly = await index.recall({ ...input, query: "dark" });
  assert.deepEqual(metadataOnly.results[0]?.matchedTerms, []);
  assert.deepEqual(metadataOnly.results[0]?.metadataMatches, ["dark"]);
  const miss = await index.recall({ ...input, query: "unrelated" });
  assert.equal(miss.attachment, undefined);
  assert.equal(miss.results.length, 0);
});

test("sourceHash uses complete original bytes, never LF-normalized text or a truncated hash", async () => {
  const raw = "---\r\ndescription: alpha\r\n---\r\nalpha preference\r\n";
  const large = `alpha ${"x".repeat(MEMORY_RECALL_INDEX_FILE_MAX_BYTES)}`;
  const harness = createRecallHarness(
    new Map([
      [join(ROOT, "complete.md"), { content: raw }],
      [join(ROOT, "large.md"), { content: large }],
      [join(ROOT, "unversioned.md"), { content: "alpha preference", omitHash: true }],
    ]),
  );
  const result = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  const complete = result.results.find((entry) => entry.filename === "complete.md")!;
  assert.equal(complete.sourceHash, hashContent(raw));
  assert.notEqual(complete.sourceHash, hashContent(raw.replace(/\r\n/gu, "\n")));
  assert.equal(
    result.results.find((entry) => entry.filename === "large.md")?.sourceHash,
    undefined,
  );
  assert.equal(
    result.results.find((entry) => entry.filename === "unversioned.md")?.sourceHash,
    undefined,
  );
  assert.equal(result.health?.truncatedFileCount, 1);
  assert.equal(
    result.health?.indexedBytes,
    Buffer.byteLength(raw) +
      MEMORY_RECALL_INDEX_FILE_MAX_BYTES +
      Buffer.byteLength("alpha preference"),
  );
  assert.equal(result.scan?.complete, true);
});

test("corpus reads remain bounded and health reports skipped candidates and truncated files", async () => {
  const files = new Map<string, RecallTestFile>();
  const maximumFiles = MEMORY_RECALL_CORPUS_MAX_BYTES / MEMORY_RECALL_INDEX_FILE_MAX_BYTES;
  for (let index = 0; index < maximumFiles + 3; index++) {
    files.set(join(ROOT, `topic-${String(index).padStart(3, "0")}.md`), {
      content: `alpha ${"x".repeat(MEMORY_RECALL_INDEX_FILE_MAX_BYTES)}`,
    });
  }
  const harness = createRecallHarness(files);
  const outcome = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  assert.equal(outcome.candidateCount, maximumFiles + 3);
  assert.equal(outcome.indexedCount, maximumFiles);
  assert.equal(outcome.health?.indexedBytes, MEMORY_RECALL_CORPUS_MAX_BYTES);
  assert.equal(outcome.health?.scanLimited, true);
  assert.equal(outcome.health?.truncatedFileCount, maximumFiles);
  assert.equal(harness.reads.length, maximumFiles);
  assert.ok(outcome.results.length <= 4);
  assert.ok(harness.reads.every((read) => read.maxBytes! <= MEMORY_RECALL_INDEX_FILE_MAX_BYTES));
});

test("a file growing after stat cannot borrow another candidate's reserved byte budget", async () => {
  const harness = createRecallHarness(
    new Map([[join(ROOT, "growing.md"), { content: "alpha larger body", sizeBytes: 5 }]]),
  );
  const read = harness.fileSystem.readTextFile.bind(harness.fileSystem);
  harness.fileSystem.readTextFile = async (request, options) => ({
    ...(await read(request, options)),
    sizeBytes: Buffer.byteLength("alpha larger body"),
  });
  const result = await new ProjectMemoryRecallIndex().recall({
    fileSystem: harness.fileSystem,
    query: "alpha",
    rootDir: ROOT,
  });
  assert.equal(harness.reads[0]?.maxBytes, 5);
  assert.equal(result.health?.indexedBytes, 5);
  assert.equal(result.health?.truncatedFileCount, 1);
  assert.equal(result.results[0]?.sourceHash, undefined);
});
