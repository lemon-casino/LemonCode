import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { MessageId, MessageWithParts, PartId, WorkspaceId } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { validateMemoryReviewSources } from "./review-validation.js";
import {
  oneReviewItem,
  reviewHarness,
  reviewMessage,
  REVIEW_CURRENT_SESSION,
  REVIEW_FIXTURE_MEMORY_ROOT,
  REVIEW_PAST_SESSION,
} from "./review-test-fixtures.js";

const QUERY = "Review memory design";

test("application re-reads the same frozen projection and rejects removed or hidden sources", async () => {
  for (const change of ["deleted", "hidden", "changed", "archived", "branch", "scope"] as const) {
    const h = reviewHarness();
    const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
    await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
    if (change === "deleted") h.sessions.delete(REVIEW_PAST_SESSION);
    if (change === "hidden") {
      const message = h.transcripts.get(REVIEW_PAST_SESSION)![0]!;
      if (message.info.role === "user") message.info.visibility = "model-only";
    }
    if (change === "changed")
      h.transcripts.set(REVIEW_PAST_SESSION, [reviewMessage(REVIEW_PAST_SESSION, "Changed fact")]);
    if (change === "archived") h.sessions.get(REVIEW_PAST_SESSION)!.time.archived = 4;
    if (change === "branch")
      h.sessions.get(REVIEW_PAST_SESSION)!.revert = {
        messageID: "msg_cut" as MessageId,
        branchGeneration: 2,
      };
    if (change === "scope")
      h.sessions.get(REVIEW_PAST_SESSION)!.workspaceID = "different-identity" as WorkspaceId;
    await assert.rejects(
      validateMemoryReviewSources({ sources: draft.sources, context: h.context }),
      change,
    );
  }
});

test("new tool-only assistant events and time.updated do not invalidate unchanged visible evidence", async () => {
  const h = reviewHarness();
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  const messageID = "msg_review_tool_only" as MessageId;
  h.transcripts.get(REVIEW_CURRENT_SESSION)!.push({
    info: {
      id: messageID,
      sessionID: REVIEW_CURRENT_SESSION,
      role: "assistant",
      parentID: "msg_review_current" as MessageId,
      time: { created: 2 },
      mode: "build",
      agent: "build",
      path: { cwd: h.context.workspaceRoot, root: h.context.workspaceRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "part_review_tool" as PartId,
        sessionID: REVIEW_CURRENT_SESSION,
        messageID,
        type: "tool",
        callID: "call_review_fixture",
        tool: "Read",
        state: { status: "running", input: { file_path: "fixture.txt" }, time: { start: 2 } },
      },
    ],
  } as MessageWithParts);
  h.sessions.get(REVIEW_CURRENT_SESSION)!.time.updated = 100;
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
  assert.equal(h.requests.length, 1);
});

test("rewind discard stays hidden and a changed branch generation rejects even identical text", async () => {
  const h = reviewHarness();
  const kept = reviewMessage(REVIEW_PAST_SESSION, "KEEP_ACTIVE", "msg_keep");
  const discarded = reviewMessage(REVIEW_PAST_SESSION, "DISCARD_SECRET", "msg_discard");
  h.transcripts.set(REVIEW_PAST_SESSION, [kept, discarded]);
  h.sessions.get(REVIEW_PAST_SESSION)!.revert = {
    messageID: discarded.info.id,
    targetMessageID: discarded.info.id,
    keptMessageIDs: [kept.info.id],
    branchCutAfterMessageID: discarded.info.id,
    branchGeneration: 1,
  };
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.ok(!JSON.stringify(h.requests).includes("DISCARD_SECRET"));
  assert.ok(JSON.stringify(h.requests).includes("KEEP_ACTIVE"));
  h.sessions.get(REVIEW_PAST_SESSION)!.revert!.branchGeneration = 2;
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
});

test("sources bind to identity and memory root before any foreign re-read", async () => {
  const h = reviewHarness();
  h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md"), { content: "Frozen memory." });
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  const reads = h.reads.length;
  const snapshots = h.snapshots.length;
  h.context.workspaceIdentity = "another-remote-identity";
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
  assert.equal(h.reads.length, reads);
  assert.equal(h.snapshots.length, snapshots);
});

test("memory changes, missing files, truncated re-reads and symlinks reject application", async () => {
  for (const change of ["changed", "missing", "truncated", "symlink"] as const) {
    const h = reviewHarness();
    const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md");
    h.files.set(path, { content: "Frozen memory." });
    const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
    await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
    if (change === "changed") h.files.set(path, { content: "Changed memory" });
    if (change === "missing") h.files.delete(path);
    if (change === "truncated") h.files.get(path)!.truncated = true;
    if (change === "symlink") h.files.get(path)!.kind = "symlink";
    await assert.rejects(
      validateMemoryReviewSources({ sources: draft.sources, context: h.context }),
      change,
    );
  }
});

test("tampered source reference or revision, duplicate sources and missing snapshot capability reject", async () => {
  const h = reviewHarness();
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  const source = draft.sources[0]!;
  for (const sources of [
    [{ ...source, reference: "sess_forged" }],
    [{ ...source, revision: "sha256:forged" }],
    [source, source],
    [{ ...source, kind: "memory" as const, reference: "../outside.md" }],
  ])
    await assert.rejects(validateMemoryReviewSources({ sources, context: h.context }));
  h.store.readTranscriptSnapshot = undefined;
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
});

test("storage prefix truncation never exposes old text or passes application revalidation", async () => {
  const h = reviewHarness();
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  const read = h.store.readTranscriptSnapshot!;
  h.store.readTranscriptSnapshot = async (input) => ({ ...(await read(input)), truncated: true });
  const partial = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.sources, []);
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
});

test("missing rewind anchors cannot fall back to the complete discarded transcript", async () => {
  const h = reviewHarness();
  h.sessions.get(REVIEW_PAST_SESSION)!.revert = {
    messageID: "missing_target" as MessageId,
    targetMessageID: "missing_target" as MessageId,
  };
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
  assert.equal(h.requests.length, 0);
});

test("scope and branch changes during snapshot loading fail closed", async () => {
  for (const change of ["identity", "branch"] as const) {
    const h = reviewHarness();
    const read = h.store.readTranscriptSnapshot!;
    h.store.readTranscriptSnapshot = async (input) => {
      const snapshot = await read(input);
      const session = h.sessions.get(input.sessionID)!;
      if (change === "identity") session.workspaceID = "changed-remote" as WorkspaceId;
      else session.revert = { messageID: "msg_new_branch" as MessageId, branchGeneration: 5 };
      return snapshot;
    };
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
    assert.equal(h.requests.length, 0);
  }
});
