import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MEMORY_EFFECT_TURN_LIMIT, type MemoryEffectTurn } from "@lcode/contracts";
import { NodeFileSystemAdapter } from "./index.js";
import { digest, hasCode, memoryFixture, reviewDraft } from "./project-memory.test-support.js";

const workspaceKey = digest("synthetic-identity");
function observation(overrides: Partial<MemoryEffectTurn> = {}): MemoryEffectTurn {
  return {
    schemaVersion: 1,
    workspaceKey,
    sessionId: "fixture-session",
    turnId: "fixture-turn",
    observedAt: 1,
    status: "completed",
    verification: "unknown",
    entries: [
      {
        fileName: "fact.md",
        sourceHash: digest("fixture"),
        injectedCharacters: 7,
        matchedTermCount: 1,
        metadataMatchCount: 0,
      },
    ],
    ...overrides,
  };
}

test("observation is durable and duplicate settlement does not change time or content", async (t) => {
  const h = await memoryFixture(t);
  const turn = observation();
  assert.equal(await h.memory.effects!.recordTurn({ rootDir: h.rootDir, turn }), "recorded");
  const restored = new NodeFileSystemAdapter();
  await restored.projectMemory!.registerRoot(h.rootDir);
  assert.equal(
    await restored.projectMemory!.effects!.recordTurn({
      rootDir: h.rootDir,
      turn: { ...turn, observedAt: 200 },
    }),
    "duplicate",
  );
  const snapshot = await restored.projectMemory!.effects!.read({
    rootDir: h.rootDir,
    workspaceKey,
  });
  assert.equal(snapshot.turnCount, 1);
  assert.equal(snapshot.turns[0]!.observedAt, 1);
  assert.equal(snapshot.turns[0]!.verification, "unknown");
  await assert.rejects(
    h.memory.effects!.recordTurn({ rootDir: h.rootDir, turn: { ...turn, status: "error" } }),
    hasCode("stale_write"),
  );
  await assert.rejects(
    h.memory.effects!.read({ rootDir: h.rootDir, workspaceKey: digest("other-identity") }),
    hasCode("invalid_path"),
  );
});

test("feedback binds an actually injected revision and command id, never task success", async (t) => {
  const h = await memoryFixture(t);
  await h.memory.effects!.recordTurn({ rootDir: h.rootDir, turn: observation() });
  const feedback = {
    schemaVersion: 1 as const,
    workspaceKey,
    commandId: "explicit-feedback",
    sessionId: "fixture-session",
    turnId: "fixture-turn",
    fileName: "fact.md",
    sourceHash: digest("fixture"),
    feedback: "correction" as const,
    recordedAt: 2,
  };
  assert.equal(
    await h.memory.effects!.recordFeedback({ rootDir: h.rootDir, feedback }),
    "recorded",
  );
  assert.equal(
    await h.memory.effects!.recordFeedback({
      rootDir: h.rootDir,
      feedback: { ...feedback, recordedAt: 9 },
    }),
    "duplicate",
  );
  await assert.rejects(
    h.memory.effects!.recordFeedback({
      rootDir: h.rootDir,
      feedback: { ...feedback, commandId: "other-command", sourceHash: digest("changed") },
    }),
    hasCode("invalid_path"),
  );
  const signals = await h.memory.effects!.rankingSignals({
    rootDir: h.rootDir,
    workspaceKey,
    entries: [{ fileName: "fact.md", sourceHash: digest("fixture") }],
  });
  assert.equal(signals[0]!.relevant, 0);
  assert.equal(signals[0]!.negative, 1);
  assert.equal(signals[0]!.eligible, false);
});

test("two independent adapters serialize a duplicate observation on the same registered root", async (t) => {
  const h = await memoryFixture(t);
  const other = new NodeFileSystemAdapter();
  await other.projectMemory!.registerRoot(h.rootDir);
  const result = await Promise.all([
    h.memory.effects!.recordTurn({ rootDir: h.rootDir, turn: observation() }),
    other.projectMemory!.effects!.recordTurn({ rootDir: h.rootDir, turn: observation() }),
  ]);
  assert.deepEqual(result.sort(), ["duplicate", "recorded"]);
  assert.equal((await h.memory.effects!.read({ rootDir: h.rootDir, workspaceKey })).turnCount, 1);
});

test("late verification appends an event reference, keeps the initial observation and projects its latest verdict", async (t) => {
  const h = await memoryFixture(t);
  await h.memory.effects!.recordTurn({ rootDir: h.rootDir, turn: observation() });
  const verdict = {
    schemaVersion: 1 as const,
    workspaceKey,
    sessionId: "fixture-session",
    turnId: "fixture-turn",
    evidenceId: "verified-event",
    recordedAt: 2,
    verification: "passed" as const,
    basis: "strict-evidence" as const,
  };
  assert.equal(
    await h.memory.effects!.recordVerification({ rootDir: h.rootDir, verification: verdict }),
    "recorded",
  );
  assert.equal(
    await h.memory.effects!.recordVerification({
      rootDir: h.rootDir,
      verification: { ...verdict, recordedAt: 200 },
    }),
    "duplicate",
  );
  assert.equal(
    await h.memory.effects!.recordVerification({
      rootDir: h.rootDir,
      verification: { ...verdict, turnId: "unobserved-turn", evidenceId: "other-event" },
    }),
    "unobserved",
  );
  const snapshot = await h.memory.effects!.read({ rootDir: h.rootDir, workspaceKey });
  assert.equal(snapshot.turns[0]!.verification, "passed");
  assert.equal(snapshot.turns[0]!.verificationEvidenceId, verdict.evidenceId);
  const raw = JSON.parse(await readFile(join(h.stateDir, "effects.json"), "utf8"));
  assert.equal(raw.turns[0].verification, "unknown", "original observation remains immutable");
  assert.equal(raw.verifications.length, 1);
});

test("ranking eligibility requires accepted independent review, committed item and exact current revision", async (t) => {
  const h = await memoryFixture(t);
  const draft = reviewDraft(
    "---\nmetadata:\n  type: reference\n---\nA validated synthetic observation.",
  );
  const review = await h.memory.saveReview({
    rootDir: h.rootDir,
    draft,
    verification: {
      acceptedItemIds: [draft.items[0]!.id],
      rankingEligibleItemIds: [draft.items[0]!.id],
      reasons: [{ itemId: draft.items[0]!.id, reason: "Verified observation, no instruction." }],
    },
  });
  const item = draft.items[0]!;
  const change = await h.memory.applyReview({
    rootDir: h.rootDir,
    proposalId: review.id,
    revision: review.revision,
    itemId: item.id,
    expectedItemHash: digest(JSON.stringify(item)),
    expectedSourceHashes: [],
  });
  const readSignals = (sourceHash: string) =>
    h.memory.effects!.rankingSignals({
      rootDir: h.rootDir,
      workspaceKey,
      entries: [{ fileName: "fact.md", sourceHash }],
    });
  assert.equal((await readSignals(change.afterHash))[0]!.eligible, true);
  assert.equal((await readSignals(digest("changed")))[0]!.eligible, false);
  await h.adapter.writeTextFile({
    path: join(h.rootDir, "fact.md"),
    content: "User-edited body",
    expectedRevision: { id: change.afterHash, hash: change.afterHash },
  });
  assert.equal((await readSignals(digest("User-edited body")))[0]!.eligible, false);
});

test("full, cancelled and corrupt observation files preserve existing records and content writer", async (t) => {
  const h = await memoryFixture(t);
  const path = join(h.stateDir, "effects.json");
  const ledger = {
    schemaVersion: 1,
    rootDir: h.rootDir,
    workspaceKey,
    turns: Array.from({ length: MEMORY_EFFECT_TURN_LIMIT }, (_, index) =>
      observation({ turnId: `turn-${index}` }),
    ),
    feedback: [],
    verifications: [],
  };
  await writeFile(path, JSON.stringify(ledger));
  const before = await readFile(path);
  assert.equal(
    await h.memory.effects!.recordTurn({
      rootDir: h.rootDir,
      turn: observation({ turnId: "new-turn" }),
    }),
    "full",
  );
  assert.deepEqual(await readFile(path), before);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.memory.effects!.recordTurn(
      { rootDir: h.rootDir, turn: observation() },
      { signal: controller.signal },
    ),
  );
  await writeFile(path, "invalid json");
  await assert.rejects(
    h.memory.effects!.read({ rootDir: h.rootDir, workspaceKey }),
    hasCode("io_error"),
  );
  await h.adapter.writeTextFile({
    path: join(h.rootDir, "ordinary.md"),
    content: "preserved content",
    expectedMissing: true,
  });
  assert.equal(await readFile(join(h.rootDir, "ordinary.md"), "utf8"), "preserved content");
  assert.equal(await readFile(path, "utf8"), "invalid json");
});

test("unsafe relative paths and unregistered roots are rejected", async (t) => {
  const h = await memoryFixture(t);
  const turn = observation();
  turn.entries[0]!.fileName = "../outside.md";
  await assert.rejects(h.memory.effects!.recordTurn({ rootDir: h.rootDir, turn }));
  await assert.rejects(
    h.memory.effects!.read({ rootDir: join(h.base, "unregistered"), workspaceKey }),
  );
});
