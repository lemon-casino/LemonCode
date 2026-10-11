import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, MessageWithParts } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { validateMemoryReviewSources } from "./review-validation.js";
import {
  oneReviewItem,
  reviewHarness,
  reviewMessage,
  REVIEW_CURRENT_SESSION,
} from "./review-test-fixtures.js";

function proofHarness() {
  const h = reviewHarness();
  const cut = "msg_branch_cut" as MessageId;
  const assistant = (id: string, text: string): MessageWithParts => {
    const message = reviewMessage(REVIEW_CURRENT_SESSION, text, id);
    return { ...message, info: { ...message.info, role: "assistant" } } as MessageWithParts;
  };
  h.sessions.get(REVIEW_CURRENT_SESSION)!.revert = {
    messageID: cut,
    targetMessageID: cut,
    branchCutAfterMessageID: cut,
    branchGeneration: 1,
  };
  const done = assistant("msg_done", "Confirmed latest fact");
  h.transcripts.set(REVIEW_CURRENT_SESSION, [
    assistant(cut, "DISCARDED_BRANCH"),
    ...Array.from({ length: 300 }, (_, i) => assistant(`msg_new_${i}`, "Earlier new branch")),
    reviewMessage(REVIEW_CURRENT_SESSION, "LATEST_DURABLE_USER_FACT", "msg_user"),
    done,
    reviewMessage(REVIEW_CURRENT_SESSION, "FUTURE_MESSAGE", "msg_future"),
  ]);
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: done.info.id };
  const read = h.store.readTranscriptWindow!;
  const proof = { messageID: cut, branchGeneration: 1 };
  h.store.readTranscriptWindow = async (input) => ({
    ...(await read(input)),
    branchCutBeforeWindow: { ...proof },
  });
  h.state.reply = oneReviewItem;
  return { ...h, proof };
}

test("same-snapshot cut proof admits a complete new branch after the cut leaves the window", async () => {
  const h = proofHarness();
  const draft = await generateMemoryReviewDraft({ query: "Latest facts", context: h.context });
  assert.equal(draft.items.length, 1);
  assert.equal(h.requests.length, 1);
  assert.match(JSON.stringify(h.requests), /LATEST_DURABLE_USER_FACT/u);
  assert.doesNotMatch(JSON.stringify(h.requests), /DISCARDED_BRANCH|FUTURE_MESSAGE/u);
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
});

test("mismatched cut, generation or non-truncated prefix never authorizes a missing cut", async () => {
  for (const invalid of ["cut", "generation", "prefix"] as const) {
    const h = proofHarness();
    if (invalid === "cut") h.proof.messageID = "msg_foreign" as MessageId;
    if (invalid === "generation") h.proof.branchGeneration = 2;
    if (invalid === "prefix") {
      const read = h.store.readTranscriptWindow!;
      h.store.readTranscriptWindow = async (input) => ({
        ...(await read(input)),
        prefixTruncated: false,
      });
    }
    const draft = await generateMemoryReviewDraft({ query: "Latest facts", context: h.context });
    assert.equal(draft.sources.length, 0, invalid);
    assert.equal(h.requests.length, 0, invalid);
  }
});

test("a changed branch generation invalidates sources before commit even with an old proof", async () => {
  const h = proofHarness();
  const draft = await generateMemoryReviewDraft({ query: "Latest facts", context: h.context });
  assert.equal(draft.sources.length, 1);
  h.sessions.get(REVIEW_CURRENT_SESSION)!.revert!.branchGeneration = 2;
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
  assert.equal(h.requests.length, 1);
});
