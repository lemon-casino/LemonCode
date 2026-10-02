import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { MessageId, MessageWithParts, PartId, ToolPart } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { validateMemoryReviewSources } from "./review-validation.js";
import {
  oneReviewItem,
  reviewHarness,
  reviewMessage,
  REVIEW_FIXTURE_MEMORY_ROOT,
  REVIEW_CURRENT_SESSION,
  REVIEW_PAST_SESSION,
} from "./review-test-fixtures.js";

function reviewTurn(tool = "MemoryReview", action = "create"): MessageWithParts {
  const message = reviewMessage(REVIEW_PAST_SESSION, "UNADOPTED_PROPOSAL_FACT", "msg_past_review");
  return {
    ...message,
    info: { ...message.info, role: "assistant" },
    parts: [
      ...message.parts,
      {
        id: "part_past_review_tool" as PartId,
        messageID: message.info.id,
        sessionID: REVIEW_PAST_SESSION,
        type: "tool",
        callID: "call_past_review",
        tool,
        state: {
          status: "completed",
          input: { action },
          output: "UNADOPTED_PROPOSAL_FACT",
          title: "Review",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  } as MessageWithParts;
}

test("old proposal turns and their assistant followups are excluded before evidence projection", async () => {
  for (const [tool, action] of [
    ["MemoryReview", "create"],
    ["MemoryReview", "read"],
    ["MemoryReview", "list"],
    ["MemoryReviewApply", "apply"],
    ["MemoryHistory", "undo"],
  ]) {
    const h = reviewHarness();
    const followup = reviewMessage(REVIEW_PAST_SESSION, "UNADOPTED_SUMMARY", "msg_past_summary");
    h.transcripts.set(REVIEW_PAST_SESSION, [
      reviewMessage(REVIEW_PAST_SESSION, "OLD_BEFORE_REVIEW", "msg_before"),
      reviewTurn(tool, action),
      { ...followup, info: { ...followup.info, role: "assistant" } } as MessageWithParts,
      reviewMessage(REVIEW_PAST_SESSION, "NEW_REAL_FACT", "msg_real_suffix"),
    ]);
    const draft = await generateMemoryReviewDraft({ query: "Review facts", context: h.context });
    const text = JSON.stringify(h.requests);
    assert.ok(text.includes("NEW_REAL_FACT"));
    assert.ok(!text.includes("UNADOPTED"));
    assert.ok(!text.includes("OLD_BEFORE_REVIEW"));
    assert.ok(draft.partial);
    await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
  }
});

test("review suffix without a real user boundary is skipped, including synthetic notices", async () => {
  const h = reviewHarness();
  const notice = reviewMessage(REVIEW_PAST_SESSION, "SYNTHETIC_CONTINUATION", "msg_notice");
  if (notice.info.role === "user") notice.info.synthetic = true;
  const followup = reviewMessage(REVIEW_PAST_SESSION, "UNADOPTED_SUMMARY", "msg_summary");
  h.transcripts.set(REVIEW_PAST_SESSION, [
    reviewTurn(),
    notice,
    { ...followup, info: { ...followup.info, role: "assistant" } } as MessageWithParts,
  ]);
  const draft = await generateMemoryReviewDraft({ query: "Review facts", context: h.context });
  assert.ok(!draft.sources.some((source) => source.reference === REVIEW_PAST_SESSION));
  assert.ok(!JSON.stringify(h.requests).includes("UNADOPTED"));
  assert.ok(draft.partial);
});

test("legacy source-tagged notices do not reopen the assistant proposal suffix", async () => {
  const h = reviewHarness();
  const notice = reviewMessage(REVIEW_PAST_SESSION, "LEGACY_NOTICE", "msg_legacy_notice");
  if (notice.info.role === "user")
    notice.info.source = "system_reminder" as NonNullable<typeof notice.info.source>;
  const followup = reviewMessage(
    REVIEW_PAST_SESSION,
    "UNADOPTED_BETWEEN_NOTICE_AND_USER",
    "msg_legacy_summary",
  );
  h.transcripts.set(REVIEW_PAST_SESSION, [
    reviewTurn(),
    notice,
    { ...followup, info: { ...followup.info, role: "assistant" } } as MessageWithParts,
    reviewMessage(REVIEW_PAST_SESSION, "REAL_SUFFIX", "msg_real_after_notice"),
  ]);
  await generateMemoryReviewDraft({ query: "Review facts", context: h.context });
  assert.ok(!JSON.stringify(h.requests).includes("UNADOPTED"));
  assert.ok(JSON.stringify(h.requests).includes("REAL_SUFFIX"));
});

test("a new foreground review invalidates sources rather than treating its proposal as facts", async () => {
  const h = reviewHarness();
  const draft = await generateMemoryReviewDraft({ query: "Review facts", context: h.context });
  h.transcripts.get(REVIEW_PAST_SESSION)!.push(reviewTurn());
  await assert.rejects(validateMemoryReviewSources({ sources: draft.sources, context: h.context }));
});

test("manual review ignores only its own unfinished ToolPart, preserving the real user request", async () => {
  for (const status of ["pending", "running", "completed", "other-call"] as const) {
    const h = reviewHarness();
    h.sessions.delete(REVIEW_PAST_SESSION);
    const user = reviewMessage(
      REVIEW_CURRENT_SESSION,
      "Use pnpm for this project.",
      "msg_manual_user",
    );
    const messageID = "msg_manual_review" as MessageId;
    const part: ToolPart = {
      id: "part_manual_review" as PartId,
      sessionID: REVIEW_CURRENT_SESSION,
      messageID,
      type: "tool",
      tool: "MemoryReview",
      callID: status === "other-call" ? "call_other" : h.context.toolCallId,
      state:
        status === "pending"
          ? { status, input: { action: "create" }, raw: "{}" }
          : status === "completed"
            ? {
                status,
                input: { action: "create" },
                output: "proposal",
                title: "Review",
                metadata: {},
                time: { start: 1, end: 2 },
              }
            : { status: "running", input: { action: "create" }, time: { start: 1 } },
    };
    const assistant: MessageWithParts = {
      info: {
        id: messageID,
        sessionID: REVIEW_CURRENT_SESSION,
        role: "assistant",
        parentID: user.info.id,
        time: { created: 1 },
        mode: "build",
        agent: "build",
        path: { cwd: h.context.workspaceRoot, root: h.context.workspaceRoot },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [part],
    };
    h.transcripts.set(REVIEW_CURRENT_SESSION, [user, assistant]);
    const draft = await generateMemoryReviewDraft({ query: "Review facts", context: h.context });
    if (status === "pending" || status === "running") {
      assert.equal(draft.sources.length, 1);
      assert.ok(JSON.stringify(h.requests).includes("Use pnpm"));
      await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
    } else assert.deepEqual(draft.sources, []);
  }
});

test("generation discards byte-identical normalized target content as a no-op without rereading", async () => {
  const h = reviewHarness();
  const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md");
  h.files.set(path, { content: "Same fact\n", rawContent: "Same fact\r\n" });
  h.state.reply = (request) => oneReviewItem(request, { content: "Same fact\n" });
  const draft = await generateMemoryReviewDraft({ query: "Review facts", context: h.context });
  assert.deepEqual(draft.items, []);
  assert.equal(h.reads.filter((read) => read === path).length, 1);
});
