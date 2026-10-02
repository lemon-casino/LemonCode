import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { MessageId, MessageWithParts, PartId } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { validateMemoryReviewSources } from "./review-validation.js";
import { verifyMemoryReviewDraft } from "./review-verification.js";
import {
  oneReviewItem,
  reviewDecisionResponse,
  reviewHarness,
  reviewMessage,
  REVIEW_CURRENT_SESSION,
  REVIEW_FIXTURE_MEMORY_ROOT,
} from "./review-test-fixtures.js";

function windowHarness() {
  const h = reviewHarness();
  const lastUser = reviewMessage(REVIEW_CURRENT_SESSION, "LATEST_REAL_TURN", "msg_recent_user");
  const done = assistant("LATEST_COMPLETED_RESPONSE", "msg_recent_done");
  const old = Array.from({ length: 300 }, (_, index) =>
    assistant("OLD_PREFIX_CONTENT", `msg_old_${index}`),
  );
  h.transcripts.set(REVIEW_CURRENT_SESSION, [
    ...old,
    lastUser,
    done,
    reviewMessage(REVIEW_CURRENT_SESSION, "FUTURE_INFLIGHT", "msg_future"),
  ]);
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: done.info.id };
  h.store.readTranscriptSnapshot = async () => {
    throw new Error("No prefix snapshot on incremental path");
  };
  h.store.messages = async () => {
    throw new Error("No unbounded transcript fallback");
  };
  h.store.listSessions = async () => {
    throw new Error("No historical session scan");
  };
  return h;
}

function assistant(text: string, id: string): MessageWithParts {
  const message = reviewMessage(REVIEW_CURRENT_SESSION, text, id);
  return { ...message, info: { ...message.info, role: "assistant" } } as MessageWithParts;
}

test("long session incremental review uses a complete tail window with prefixTruncated=true", async () => {
  const h = windowHarness();
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
  assert.equal(h.windows.length, 1);
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.windows[0]!.throughMessageID, "msg_recent_done");
  assert.ok(h.windows[0]!.limits.maxMessageRows <= 256);
  const request = JSON.stringify(h.requests[0]);
  assert.ok(request.includes("LATEST_REAL_TURN"));
  assert.ok(request.includes("LATEST_COMPLETED_RESPONSE"));
  assert.ok(!request.includes("OLD_PREFIX_CONTENT"));
  assert.ok(!request.includes("FUTURE_INFLIGHT"));
  assert.equal(draft.sources[0]!.projection, "latest-turn");
  assert.ok(draft.partial);
  h.state.reply = () => reviewDecisionResponse(draft);
  await verifyMemoryReviewDraft({ draft, context: h.context });
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
  assert.equal(h.windows.length, 3);
  assert.equal(h.requests.length, 2);
});

test("missing window capability fails closed instead of using snapshot or messages", async () => {
  const h = windowHarness();
  h.store.readTranscriptWindow = undefined;
  await assert.rejects(generateMemoryReviewDraft({ query: "Recent facts", context: h.context }));
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.snapshots, []);
  assert.deepEqual(h.reads, []);
});

test("anchor missing, incomplete window or missing real-user turn skip before memory or model", async () => {
  for (const failure of ["anchor", "truncated", "user", "wrong-anchor"] as const) {
    const h = windowHarness();
    h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md"), {
      content: "Do not review memory alone",
    });
    const read = h.store.readTranscriptWindow!;
    h.store.readTranscriptWindow = async (input) => {
      const window = await read(input);
      if (failure === "anchor") return { ...window, boundaryFound: false };
      if (failure === "truncated") return { ...window, truncated: true };
      if (failure === "wrong-anchor")
        return { ...window, throughMessageID: "msg_wrong" as MessageId };
      const messages = window.messages.filter((message) => message.info.role !== "user");
      return {
        ...window,
        messages,
        loadedMessageCount: messages.length,
        loadedPartCount: messages.reduce((count, message) => count + message.parts.length, 0),
      };
    };
    const draft = await generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
    assert.deepEqual(draft.items, []);
    assert.deepEqual(draft.sources, []);
    assert.ok(draft.partial);
    assert.equal(h.requests.length, 0, failure);
    assert.equal(h.reads.length, 0, failure);
    assert.equal(h.stats.length, 0, failure);
  }
});

test("a window re-read that loses its anchor rejects verification and final application", async () => {
  const h = windowHarness();
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
  const read = h.store.readTranscriptWindow!;
  h.store.readTranscriptWindow = async (input) => ({
    ...(await read(input)),
    boundaryFound: false,
  });
  await assert.rejects(verifyMemoryReviewDraft({ draft, context: h.context }));
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
  assert.equal(h.requests.length, 1);
});

test("an in-window rewind cut proves the new suffix without old target or kept anchors", async () => {
  const h = windowHarness();
  const messages = h.transcripts.get(REVIEW_CURRENT_SESSION)!;
  const cut = messages[299]!;
  h.sessions.get(REVIEW_CURRENT_SESSION)!.revert = {
    messageID: "msg_target_before_window" as MessageId,
    targetMessageID: "msg_target_before_window" as MessageId,
    keptMessageIDs: ["msg_kept_before_window" as MessageId],
    branchCutAfterMessageID: cut.info.id,
    branchGeneration: 1,
  };
  const draft = await generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
  assert.ok(draft.sources.length > 0);
  assert.ok(JSON.stringify(h.requests).includes("LATEST_REAL_TURN"));
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
});

test("unprovable rewind boundaries outside the window do not reopen discarded text", async () => {
  const h = windowHarness();
  h.sessions.get(REVIEW_CURRENT_SESSION)!.revert = {
    messageID: "missing_target" as MessageId,
    targetMessageID: "missing_target" as MessageId,
    branchCutAfterMessageID: "missing_cut" as MessageId,
    keptMessageIDs: ["missing_keep" as MessageId],
    branchGeneration: 1,
  };
  const draft = await generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
  assert.deepEqual(draft.items, []);
  assert.deepEqual(draft.sources, []);
  assert.equal(h.requests.length, 0);
});

test("compact summaries never substitute for a complete real-user turn in the window", async () => {
  for (const hasRealSuffix of [false, true]) {
    const h = windowHarness();
    const compact = reviewMessage(REVIEW_CURRENT_SESSION, "COMPACT_DERIVED_TEXT", "msg_compact");
    compact.parts.push({
      id: "part_compact" as PartId,
      messageID: compact.info.id,
      sessionID: REVIEW_CURRENT_SESSION,
      type: "compaction",
      auto: true,
    } as MessageWithParts["parts"][number]);
    const summary = assistant("COMPACT_SUMMARY_NOT_REAL", "msg_summary");
    if (summary.info.role === "assistant") summary.info.summary = true;
    const messages = h.transcripts.get(REVIEW_CURRENT_SESSION)!;
    const prefix = messages.slice(0, 300);
    const suffix = hasRealSuffix ? [messages[300]!] : [];
    h.transcripts.set(REVIEW_CURRENT_SESSION, [
      ...prefix,
      compact,
      summary,
      ...suffix,
      messages[301]!,
    ]);
    const draft = await generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
    assert.equal(h.requests.length, hasRealSuffix ? 1 : 0);
    assert.ok(!JSON.stringify(h.requests).includes("COMPACT_DERIVED_TEXT"));
    assert.ok(!JSON.stringify(h.requests).includes("COMPACT_SUMMARY_NOT_REAL"));
    if (!hasRealSuffix) assert.deepEqual(draft.sources, []);
  }
});

test("incremental memory selection uses frozen turn terms instead of the generic review query", async () => {
  const h = windowHarness();
  const user = h.transcripts.get(REVIEW_CURRENT_SESSION)![300]!;
  if (user.parts[0]?.type === "text")
    user.parts[0].text = "The zebra parser requires stable offsets.";
  for (const fileName of ["a-unrelated.md", "b-unrelated.md", "zebra-topic.md"]) {
    h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, fileName), { content: `Fact in ${fileName}` });
  }
  await generateMemoryReviewDraft({ query: "Review recent reusable facts", context: h.context });
  assert.equal(h.reads[0], join(REVIEW_FIXTURE_MEMORY_ROOT, "zebra-topic.md"));
  assert.equal(h.reads.length, 2);
});

test("cancelling a pending window read stops generation before memory or model", async () => {
  const h = windowHarness();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.store.readTranscriptWindow = () => {
    started();
    return new Promise(() => {});
  };
  const pending = generateMemoryReviewDraft({ query: "Recent facts", context: h.context });
  await ready;
  h.controller.abort(new Error("PRIVATE_WINDOW_ABORT"));
  await assert.rejects(
    pending,
    (error: Error) => error.name === "AbortError" && !error.message.includes("PRIVATE"),
  );
  assert.equal(h.requests.length, 0);
  assert.equal(h.reads.length, 0);
});

test("a window's session identity must still match before any model request", async () => {
  const h = windowHarness();
  const read = h.store.readTranscriptWindow!;
  h.store.readTranscriptWindow = async (input) => {
    const window = await read(input);
    if (window.session)
      window.session.directory = join(h.context.workspaceRoot, "foreign-workspace");
    return window;
  };
  await assert.rejects(generateMemoryReviewDraft({ query: "Recent facts", context: h.context }));
  assert.equal(h.requests.length, 0);
  assert.equal(h.reads.length, 0);
});

test("full manual review retains snapshot capability and never requires a window", async () => {
  const h = reviewHarness();
  h.store.readTranscriptWindow = undefined;
  const draft = await generateMemoryReviewDraft({ query: "Historical facts", context: h.context });
  assert.ok(draft.sources.length > 0);
  assert.ok(h.snapshots.length > 0);
  assert.equal(h.windows.length, 0);
  assert.equal(h.requests.length, 1);
});
