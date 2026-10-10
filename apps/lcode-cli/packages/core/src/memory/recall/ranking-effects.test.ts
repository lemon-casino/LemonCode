import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryRankingSignal } from "@lcode/contracts";
import { applyMemoryRankingSignals, rankMemoryDocuments } from "./ranking.js";
import type { IndexedMemoryDocument } from "./types.js";
import { ProjectMemoryRecallIndex } from "./project-memory-recall.js";
import { createRecallHarness } from "./recall.test-support.js";

const hash = `sha256:${"a".repeat(64)}`;
function doc(
  type: IndexedMemoryDocument["type"] = "reference",
  sourceHash: string | undefined = hash,
): IndexedMemoryDocument {
  return {
    content: "parser",
    filePath: "/memory/fact.md",
    filename: "fact.md",
    mtimeMs: 1,
    indexedBytes: 6,
    metadataTokens: new Set(),
    termFrequencies: new Map([["parser", 1]]),
    tokenCount: 1,
    type,
    sourceHash,
  };
}
const signal: MemoryRankingSignal = {
  fileName: "fact.md",
  sourceHash: hash,
  eligible: true,
  relevant: 500,
  negative: 0,
};
test("ranking is bounded and never changes protected types, unknown provenance/revision or lexical eligibility", () => {
  const ranked = (document: IndexedMemoryDocument) =>
    rankMemoryDocuments({ documents: [document], queryTokens: ["parser"] });
  const base = ranked(doc());
  assert.equal(applyMemoryRankingSignals(base, [signal])[0]!.score, base[0]!.score * 1.2);
  assert.equal(
    applyMemoryRankingSignals(base, [{ ...signal, relevant: 0, negative: 500 }])[0]!.score,
    base[0]!.score * 0.8,
  );
  for (const type of ["user", "project", "feedback", undefined] as const) {
    const entries = ranked({ ...doc(), type });
    assert.equal(applyMemoryRankingSignals(entries, [signal])[0]!.score, entries[0]!.score);
  }
  assert.equal(
    applyMemoryRankingSignals(base, [{ ...signal, eligible: false }])[0]!.score,
    base[0]!.score,
  );
  assert.equal(
    applyMemoryRankingSignals(base, [{ ...signal, sourceHash: `sha256:${"b".repeat(64)}` }])[0]!
      .score,
    base[0]!.score,
  );
  assert.deepEqual(
    applyMemoryRankingSignals(
      rankMemoryDocuments({ documents: [doc()], queryTokens: ["unrelated"] }),
      [signal],
    ),
    [],
  );
});

test("disabled ranking never reads effects and enabled failure preserves current BM25", async () => {
  const h = createRecallHarness(
    new Map([
      ["/memory/fact.md", { content: "---\nmetadata:\n  type: reference\n---\nparser test" }],
    ]),
  );
  let calls = 0;
  let warnings = 0;
  h.fileSystem.projectMemory = {
    effects: {
      rankingSignals: async () => {
        calls++;
        throw new Error("fixture failure");
      },
    },
  } as never;
  const index = new ProjectMemoryRecallIndex();
  const base = await index.recall({
    fileSystem: h.fileSystem,
    rootDir: "/memory",
    query: "parser",
  });
  assert.equal(calls, 0);
  // Existing test adapter hashes omit the prefix; eligibility requests still use the raw supplied complete revision.
  const experimental = await index.recall({
    fileSystem: h.fileSystem,
    rootDir: "/memory",
    query: "parser",
    rankingExperiment: {
      workspaceKey: hash,
      onUnavailable: () => {
        warnings++;
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(warnings, 1);
  assert.deepEqual(experimental.results, base.results);
});
