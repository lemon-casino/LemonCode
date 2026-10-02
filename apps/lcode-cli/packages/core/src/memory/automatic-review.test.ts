import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createFileSystemError,
  type ProjectMemoryPort,
  type ProjectMemoryReview,
  type ProjectMemoryReviewDraft,
  type ProjectMemoryVerification,
} from "@lcode/contracts";
import { runAutomaticMemoryReview } from "./automatic-review.js";
import { oneReviewItem, reviewHarness } from "./review-test-fixtures.js";

function fixture(accept = true) {
  const h = reviewHarness();
  const stored: ProjectMemoryReview[] = [];
  const applications: Parameters<ProjectMemoryPort["applyReview"]>[0][] = [];
  const options = { failApply: false, mutateAfterVerification: false };
  h.state.reply = (request) => {
    if (h.requests.length === 1) return oneReviewItem(request);
    const payload = JSON.parse(String(request.messages[1]!.content));
    return {
      text: JSON.stringify({
        decisions: payload.items.map((item: { itemId: string }) => ({
          itemId: item.itemId,
          accept,
          reason: accept ? "Supported durable user preference." : "Insufficient support.",
        })),
      }),
    };
  };
  h.context.fileSystemPort!.projectMemory = {
    inspectCapacity: async () => ({ available: true }),
    async saveReview({
      draft,
      verification,
    }: {
      draft: ProjectMemoryReviewDraft;
      verification?: ProjectMemoryVerification;
    }) {
      const record: ProjectMemoryReview = {
        schemaVersion: 1,
        id: "review_fixture",
        createdAt: 1,
        revision: 1,
        draft: structuredClone(draft),
        verification,
        appliedItems: {},
      };
      stored.push(record);
      if (options.mutateAfterVerification) record.draft.items[0]!.content = "changed";
      return record;
    },
    async applyReview(input: Parameters<ProjectMemoryPort["applyReview"]>[0]) {
      applications.push(input);
      if (options.failApply)
        throw createFileSystemError({ code: "stale_write", message: "Changed" });
      const item = stored[0]!.draft.items[0]!;
      return {
        schemaVersion: 1 as const,
        id: "change_fixture",
        fileName: item.fileName,
        createdAt: 2,
        beforeHash: item.expectedHash,
        afterHash: `sha256:${createHash("sha256").update(item.content).digest("hex")}`,
        status: "committed" as const,
      };
    },
  } as ProjectMemoryPort;
  return { h, stored, applications, options };
}

test("automatic review independently verifies then applies with bound item hash without asking the user", async () => {
  const { h, stored, applications } = fixture();
  const result = await runAutomaticMemoryReview({
    query: "Review project preferences",
    context: h.context,
  });
  assert.deepEqual(result, {
    status: "completed",
    proposalId: "review_fixture",
    appliedCount: 1,
    rejectedCount: 0,
    conflictCount: 0,
  });
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every((request) => request.tools?.length === 0));
  assert.equal(applications.length, 1);
  assert.match(applications[0]!.expectedItemHash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(stored[0]!.verification?.acceptedItemIds, [stored[0]!.draft.items[0]!.id]);
});

test("AI rejection keeps current files and records why without applying", async () => {
  const { h, stored, applications } = fixture(false);
  const result = await runAutomaticMemoryReview({
    query: "Review project preferences",
    context: h.context,
  });
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.appliedCount, 0);
  assert.equal(applications.length, 0);
  assert.equal(stored[0]!.verification?.reasons[0]?.reason, "Insufficient support.");
});

test("empty candidates cost one request and do not grow sidecar history", async () => {
  const { h, stored, applications } = fixture();
  h.state.reply = () => ({ text: JSON.stringify({ summary: "No durable new fact", items: [] }) });
  const result = await runAutomaticMemoryReview({
    query: "Review project preferences",
    context: h.context,
  });
  assert.equal(result.status, "no-change");
  assert.equal(h.requests.length, 1);
  assert.equal(stored.length, 0);
  assert.equal(applications.length, 0);
});

test("version conflict skips the candidate without re-generating or overwriting", async () => {
  const { h, options, applications } = fixture();
  options.failApply = true;
  const result = await runAutomaticMemoryReview({
    query: "Review project preferences",
    context: h.context,
  });
  assert.equal(result.conflictCount, 1);
  assert.equal(result.appliedCount, 0);
  assert.equal(h.requests.length, 2);
  assert.equal(applications.length, 1);
});

test("full storage prevents all model requests before review generation", async () => {
  const { h, stored, applications } = fixture();
  h.context.fileSystemPort!.projectMemory!.inspectCapacity = async () => ({
    available: false,
    reason: "history-full",
  });
  const result = await runAutomaticMemoryReview({
    query: "Review project preferences",
    context: h.context,
  });
  assert.equal(result.skippedReason, "history-full");
  assert.equal(h.requests.length, 0);
  assert.equal(stored.length, 0);
  assert.equal(applications.length, 0);
});

test("unverified model summary never becomes persisted review metadata", async () => {
  const { h, stored } = fixture(false);
  const original = h.state.reply;
  h.state.reply = (request) => {
    const reply = original(request);
    if (h.requests.length !== 1) return reply;
    const item = oneReviewItem(request);
    const parsed = JSON.parse(item.text);
    parsed.summary = "password=FAKE_FIXTURE_ONLY_01234567";
    return { text: JSON.stringify(parsed) };
  };
  await runAutomaticMemoryReview({ query: "Review project preferences", context: h.context });
  assert.doesNotMatch(stored[0]!.draft.summary, /FAKE_FIXTURE|password/u);
  assert.equal(stored[0]!.draft.summary, "Reviewed 1 candidates; accepted 0.");
});

test("storage cannot swap the verified draft before automatic application", async () => {
  const { h, options, applications } = fixture();
  options.mutateAfterVerification = true;
  await assert.rejects(
    runAutomaticMemoryReview({ query: "Review project preferences", context: h.context }),
  );
  assert.equal(applications.length, 0);
});
