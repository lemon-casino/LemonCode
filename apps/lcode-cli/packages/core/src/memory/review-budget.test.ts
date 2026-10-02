import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { SessionId } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { validateMemoryReviewSources } from "./review-validation.js";
import {
  readReviewPrompt,
  reviewHarness,
  reviewMessage,
  reviewSession,
  REVIEW_CURRENT_SESSION,
  REVIEW_FIXTURE_MEMORY_ROOT,
} from "./review-test-fixtures.js";

test("all request fields share a hard budget, with at most eight bounded session and memory sources", async () => {
  const h = reviewHarness();
  h.sessions.clear();
  h.transcripts.clear();
  const current = reviewSession(REVIEW_CURRENT_SESSION);
  h.sessions.set(current.id, current);
  h.transcripts.set(current.id, [reviewMessage(current.id, "A".repeat(18_000), "msg_current")]);
  for (let index = 0; index < 12; index++) {
    const id = `sess_bounded_${index}` as SessionId;
    h.sessions.set(id, reviewSession(id));
    h.transcripts.set(id, [reviewMessage(id, "A".repeat(18_000), `msg_bounded_${index}`)]);
    h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, `memory-${index}.md`), {
      content: "A".repeat(3000),
    });
  }
  const draft = await generateMemoryReviewDraft({ query: "A".repeat(4000), context: h.context });
  assert.ok(JSON.stringify(h.requests[0]).length <= 96_000);
  const prompt = readReviewPrompt(h.requests[0]!);
  const sessions = prompt.sources.filter((source) => source.kind === "session");
  assert.ok(sessions.length <= 8);
  assert.ok(h.snapshots.length <= 8);
  assert.ok(sessions.every((source) => source.content.length <= 12_000));
  assert.ok(sessions.reduce((length, source) => length + source.content.length, 0) <= 64_000);
  assert.ok(prompt.sources.filter((source) => source.kind === "memory").length <= 8);
  assert.ok(h.reads.length <= 8);
  assert.equal(draft.partial, true);
  assert.ok(h.snapshots.every((snapshot) => snapshot.limits.maxDataBytes <= 256 * 1024));
  await validateMemoryReviewSources({ sources: draft.sources, context: h.context });
});

test("query and complete encoded request overflow reject rather than silently weakening boundaries", async () => {
  const h = reviewHarness();
  await assert.rejects(generateMemoryReviewDraft({ query: "x".repeat(4001), context: h.context }));
  assert.equal(h.requests.length, 0);
  const quoted = reviewHarness();
  for (const id of quoted.transcripts.keys()) {
    quoted.transcripts.set(id, [reviewMessage(id, "\u0001".repeat(12_000))]);
  }
  await assert.rejects(generateMemoryReviewDraft({ query: "Memory", context: quoted.context }));
  assert.equal(quoted.requests.length, 0);
});

test("small model context and oversized model responses are rejected with no retry", async () => {
  const small = reviewHarness();
  Object.assign(small.model.properties, { contextWindow: 64 });
  await assert.rejects(generateMemoryReviewDraft({ query: "Memory", context: small.context }));
  assert.equal(small.requests.length, 0);
  const huge = reviewHarness();
  huge.state.reply = () => ({ text: "x".repeat(100_000) });
  await assert.rejects(generateMemoryReviewDraft({ query: "Memory", context: huge.context }));
  assert.equal(huge.requests.length, 1);
});

test("partial memory cannot become an editable target and its full content is not sent", async () => {
  const h = reviewHarness();
  const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "huge.md");
  h.files.set(path, { content: "UNREAD_LARGE_FACT".repeat(10_000) });
  const draft = await generateMemoryReviewDraft({ query: "Memory", context: h.context });
  assert.ok(!draft.sources.some((source) => source.reference === "huge.md"));
  assert.equal(draft.partial, true);
  assert.ok(readReviewPrompt(h.requests[0]!).otherMemoryFileNames.includes("huge.md"));
  assert.ok(!JSON.stringify(h.requests).includes("UNREAD_LARGE_FACT"));
});
