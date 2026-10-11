import assert from "node:assert/strict";
import test from "node:test";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { verifyMemoryReviewDraft } from "./review-verification.js";
import {
  oneReviewItem,
  reviewDecisionResponse,
  reviewHarness,
  REVIEW_CURRENT_SESSION,
} from "./review-test-fixtures.js";

function incremental() {
  const h = reviewHarness();
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = {
    sessionId: REVIEW_CURRENT_SESSION,
    messageId: h.transcripts.get(REVIEW_CURRENT_SESSION)![0]!.info.id,
  };
  return h;
}

test("incremental generation and verification reserve total output for reasoning and JSON without another request", async () => {
  const h = incremental();
  h.state.reply = (request) =>
    request.options!.maxOutputTokens! < 3000
      ? { text: "", finishReason: "length" }
      : {
          ...oneReviewItem(request),
          usage: { inputTokens: 10, outputTokens: 2800, reasoningTokens: 2200 },
        };
  const draft = await generateMemoryReviewDraft({ query: "Facts", context: h.context });
  h.state.reply = (request) =>
    request.options!.maxOutputTokens! < 1500
      ? { text: "", finishReason: "length" }
      : {
          ...reviewDecisionResponse(draft),
          usage: { inputTokens: 10, outputTokens: 1400, reasoningTokens: 1000 },
        };
  const result = await verifyMemoryReviewDraft({ draft, context: h.context });
  assert.equal(result.acceptedItemIds.length, 1);
  assert.deepEqual(
    h.requests.map((r) => r.options!.maxOutputTokens),
    [4096, 2048],
  );
  assert.ok(h.requests.every((r) => r.options!.reasoningLevel === "low" && r.tools?.length === 0));
  assert.equal(h.requests.length, 2);
});

test("model maximum remains authoritative and a truncated generation has a stable phase without retry", async () => {
  const h = incremental();
  h.model.optionSpecs.maxOutputTokens.max = 1024;
  h.state.reply = () => ({ text: "", finishReason: "length" });
  await assert.rejects(generateMemoryReviewDraft({ query: "Facts", context: h.context }), {
    code: "output_truncated",
    phase: "generation",
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.options!.maxOutputTokens, 1024);
});

test("truncated verification never accepts even a parseable partial decision and never retries", async () => {
  const h = incremental();
  h.state.reply = oneReviewItem;
  const draft = await generateMemoryReviewDraft({ query: "Facts", context: h.context });
  h.state.reply = () => ({ ...reviewDecisionResponse(draft), finishReason: "length" });
  await assert.rejects(verifyMemoryReviewDraft({ draft, context: h.context }), {
    code: "output_truncated",
    phase: "verification",
  });
  assert.equal(h.requests.length, 2);
});
