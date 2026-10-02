import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { MessageId, MessageWithParts } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { validateMemoryReviewSources } from "./review-validation.js";
import { verifyMemoryReviewDraft } from "./review-verification.js";
import {
  oneReviewItem,
  readReviewPrompt,
  reviewDecisionResponse,
  reviewHarness,
  reviewMessage,
  REVIEW_CURRENT_SESSION,
  REVIEW_FIXTURE_MEMORY_ROOT,
} from "./review-test-fixtures.js";

function incrementalHarness() {
  const h = reviewHarness();
  const done = reviewMessage(REVIEW_CURRENT_SESSION, "DONE_LAST_TURN", "msg_done");
  done.info = { ...done.info, role: "assistant" } as MessageWithParts["info"];
  h.transcripts.set(REVIEW_CURRENT_SESSION, [
    reviewMessage(REVIEW_CURRENT_SESSION, "OLD_PREVIOUS_TURN", "msg_old"),
    reviewMessage(REVIEW_CURRENT_SESSION, "LAST_REAL_USER_TURN", "msg_last_real"),
    done,
    reviewMessage(REVIEW_CURRENT_SESSION, "IN_FLIGHT_NEW_USER", "msg_inflight"),
  ]);
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: done.info.id };
  h.store.listSessions = async () => {
    throw new Error("Incremental mode must not list sessions");
  };
  return h;
}

test("background uses only the last completed real-user turn with a fixed source boundary", async () => {
  const h = incrementalHarness();
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({
    query: "Incremental memory facts",
    context: h.context,
  });
  const text = JSON.stringify(h.requests[0]);
  assert.ok(text.includes("LAST_REAL_USER_TURN"));
  assert.ok(text.includes("DONE_LAST_TURN"));
  assert.ok(!text.includes("OLD_PREVIOUS_TURN"));
  assert.ok(!text.includes("IN_FLIGHT_NEW_USER"));
  assert.equal(draft.sources.filter((source) => source.kind === "session").length, 1);
  assert.equal(draft.sources[0]!.boundaryMessageId, "msg_done");
  assert.equal(draft.sources[0]!.projection, "latest-turn");
  assert.ok(h.requests[0]!.options!.maxOutputTokens! <= 1536);
  assert.ok(JSON.stringify(h.requests[0]).length <= 20_000);
  assert.equal(h.lists.length, 0);
  assert.equal(h.snapshots.length, 0);
  assert.ok(
    h.windows.length > 0 && h.windows.every((input) => input.sessionID === REVIEW_CURRENT_SESSION),
  );
  h.state.reply = () => reviewDecisionResponse(draft);
  await verifyMemoryReviewDraft({ draft, context: h.context });
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1]!.options!.maxOutputTokens! <= 768);
  assert.ok(JSON.stringify(h.requests[1]).length <= 20_000);
  assert.ok(!JSON.stringify(h.requests[1]).includes("IN_FLIGHT_NEW_USER"));
});

test("fixed boundary survives later real-user appends and rejects changed boundary or branch", async () => {
  const h = incrementalHarness();
  const draft = await generateMemoryReviewDraft({ query: "Incremental facts", context: h.context });
  h.transcripts
    .get(REVIEW_CURRENT_SESSION)!
    .push(reviewMessage(REVIEW_CURRENT_SESSION, "LATER_REAL_TURN", "msg_later"));
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
  await assert.rejects(
    validateMemoryReviewSources({
      sources: [{ ...draft.sources[0]!, boundaryMessageId: "msg_later" }],
      context: h.context,
    }),
  );
  await assert.rejects(
    validateMemoryReviewSources({
      sources: [{ ...draft.sources[0]!, projection: undefined }],
      context: h.context,
    }),
  );
  h.sessions.get(REVIEW_CURRENT_SESSION)!.revert = {
    messageID: "msg_done" as MessageId,
    branchGeneration: 3,
  };
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
});

test("incremental scope requires a real stored current-session boundary", async () => {
  for (const failure of ["missing", "wrong-session", "unknown-message"] as const) {
    const h = incrementalHarness();
    if (failure === "missing") h.context.reviewBoundary = undefined;
    if (failure === "wrong-session") h.context.reviewBoundary!.sessionId = "sess_foreign";
    if (failure === "unknown-message") h.context.reviewBoundary!.messageId = "msg_not_persisted";
    if (failure === "unknown-message") {
      const draft = await generateMemoryReviewDraft({ query: "Facts", context: h.context });
      assert.deepEqual(draft.items, []);
      assert.deepEqual(draft.sources, []);
    } else await assert.rejects(generateMemoryReviewDraft({ query: "Facts", context: h.context }));
    assert.equal(h.requests.length, 0);
  }
});

test("synthetic input is not a last-real-user boundary", async () => {
  const h = incrementalHarness();
  const messages = h.transcripts.get(REVIEW_CURRENT_SESSION)!;
  const synthetic = reviewMessage(REVIEW_CURRENT_SESSION, "SYNTHETIC_INPUT", "msg_synthetic");
  if (synthetic.info.role === "user") synthetic.info.synthetic = true;
  messages.splice(2, 0, synthetic);
  const draft = await generateMemoryReviewDraft({ query: "Facts", context: h.context });
  assert.ok(!JSON.stringify(h.requests).includes("SYNTHETIC_INPUT"));
  assert.ok(JSON.stringify(h.requests).includes("LAST_REAL_USER_TURN"));
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
});

test("incremental budgets cap session 6k, memory two reads/4k, query1k and candidates three", async () => {
  const h = incrementalHarness();
  const user = h.transcripts.get(REVIEW_CURRENT_SESSION)![1]!;
  if (user.parts[0]?.type === "text") user.parts[0].text = "A".repeat(10_000);
  for (let index = 0; index < 5; index++)
    h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, `memory-${index}.md`), {
      content: "M".repeat(3000),
    });
  const draft = await generateMemoryReviewDraft({ query: "Facts", context: h.context });
  const sources = readReviewPrompt(h.requests[0]!).sources;
  assert.ok(
    sources
      .filter((source) => source.kind === "session")
      .every((source) => source.content.length <= 6000),
  );
  assert.ok(
    sources
      .filter((source) => source.kind === "memory")
      .reduce((total, source) => total + source.content.length, 0) <= 4000,
  );
  assert.ok(h.reads.length <= 2);
  assert.ok(draft.partial);
  await assert.rejects(generateMemoryReviewDraft({ query: "q".repeat(1001), context: h.context }));
  h.state.reply = (request) => {
    const source = readReviewPrompt(request).sources[0]!;
    return {
      text: JSON.stringify({
        summary: "Too many",
        items: Array.from({ length: 4 }, (_, index) => ({
          fileName: `candidate-${index}.md`,
          content: "A fact",
          reason: "Supported",
          sourceIds: [source.id],
        })),
      }),
    };
  };
  await assert.rejects(generateMemoryReviewDraft({ query: "Facts", context: h.context }));
});

test("verification obeys incremental request and token limits even for valid draft schema", async () => {
  const h = incrementalHarness();
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({ query: "Facts", context: h.context });
  draft.items[0]!.content = "A".repeat(21_000);
  h.state.reply = () => reviewDecisionResponse(draft);
  await assert.rejects(verifyMemoryReviewDraft({ draft, context: h.context }));
  assert.equal(h.requests.length, 1);
});
