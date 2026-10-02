import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { createFileSystemError, type SessionId } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import {
  oneReviewItem,
  readReviewPrompt,
  reviewHarness,
  REVIEW_FIXTURE_MEMORY_ROOT,
} from "./review-test-fixtures.js";

const QUERY = "Review memory design";

test("forged directory children fail before any cross-root read", async () => {
  const h = reviewHarness();
  const list = h.fileSystem.listDirectory;
  const outside = resolve(REVIEW_FIXTURE_MEMORY_ROOT, "..", "outside.md");
  h.fileSystem.listDirectory = async (request, options) => ({
    ...(await list(request, options)),
    entries: [{ kind: "file", name: "outside.md", path: outside }],
  });
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
  assert.deepEqual(h.reads, []);
  assert.equal(h.requests.length, 0);
});

test("static symlinks and protected directories are not read or made editable", async () => {
  const h = reviewHarness();
  const symlink = join(REVIEW_FIXTURE_MEMORY_ROOT, "linked.md");
  h.files.set(symlink, { content: "EXTERNAL_SECRET", kind: "symlink" });
  h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, "skills", "prompt.md"), { content: "SKILL_SECRET" });
  h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, "MEMORY.md"), { content: "INDEX_SECRET" });
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.ok(draft.partial);
  assert.deepEqual(h.reads, []);
  assert.ok(!JSON.stringify(h.requests).includes("SECRET"));
  h.state.reply = (request) => oneReviewItem(request, { fileName: "linked.md" });
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
});

test("no snapshot reads occur for automation, offpeak, child or unknown remote contexts", async () => {
  for (const patch of [
    { automationTurn: true },
    { offPeakTurn: true },
    { runtimeScope: "subagent" as const },
    { remoteSessionId: "remote-without-identity" },
  ]) {
    const h = reviewHarness();
    Object.assign(h.context, patch);
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.requests.length, 0);
  }
});

test("target absent is established by not_found, not arbitrary stat errors", async () => {
  for (const code of ["permission_denied", "io_error", "unsupported"] as const) {
    const h = reviewHarness();
    const stat = h.fileSystem.stat;
    h.fileSystem.stat = async (request, options) => {
      if (request.path.endsWith("design.md"))
        throw createFileSystemError({ code, message: "PRIVATE_FS_ERROR" });
      return stat(request, options);
    };
    h.state.reply = (request) => oneReviewItem(request);
    await assert.rejects(
      generateMemoryReviewDraft({ query: QUERY, context: h.context }),
      (error: Error) => !error.message.includes("PRIVATE"),
    );
  }
});

test("new target confirmed existing after the model request is not lazily read", async () => {
  const h = reviewHarness();
  const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md");
  h.state.reply = (request) => {
    h.files.set(path, { content: "Concurrent writer" });
    return oneReviewItem(request);
  };
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
  assert.ok(!h.reads.includes(path));
});

test("filename relevance chooses at most eight candidates and lists unread reservations", async () => {
  const h = reviewHarness();
  for (let index = 0; index < 10; index++)
    h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, `aaa-${index}.md`), { content: "Unrelated" });
  const chosen = join(REVIEW_FIXTURE_MEMORY_ROOT, "z-design.md");
  h.files.set(chosen, { content: "Relevant complete memory" });
  h.state.reply = (request) => oneReviewItem(request, { fileName: "z-design.md" });
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.ok(h.reads.includes(chosen));
  assert.ok(h.reads.length <= 8);
  assert.ok(readReviewPrompt(h.requests[0]!).otherMemoryFileNames.length >= 3);
  assert.ok(draft.items[0]!.expectedHash);
});

test("synthetic-only sessions and their assistant replies never become source facts", async () => {
  const h = reviewHarness();
  for (const messages of h.transcripts.values()) {
    for (const message of messages) {
      if (message.info.role === "user") message.info.synthetic = true;
    }
    const original = structuredClone(messages[0]!);
    messages.push({
      ...original,
      info: { ...original.info, role: "assistant" },
    } as typeof original);
  }
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.equal(draft.sources.length, 0);
  assert.ok(draft.partial);
});

test("immutable request evidence survives mutations during model execution", async () => {
  const h = reviewHarness();
  const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md");
  h.files.set(path, { content: "FROZEN_MEMORY" });
  h.state.reply = (request) => {
    h.files.set(path, { content: "MUTATED_MEMORY" });
    h.transcripts.clear();
    return oneReviewItem(request);
  };
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.ok(JSON.stringify(h.requests).includes("FROZEN_MEMORY"));
  assert.ok(!JSON.stringify(h.requests).includes("MUTATED_MEMORY"));
  assert.ok(draft.sources.some((source) => source.kind === "memory"));
});

test("snapshots cannot smuggle messages from another persisted session", async () => {
  const h = reviewHarness();
  const read = h.store.readTranscriptSnapshot!;
  h.store.readTranscriptSnapshot = async (input) => {
    const snapshot = await read(input);
    if (snapshot.messages[0]) snapshot.messages[0].info.sessionID = "sess_foreign" as SessionId;
    return snapshot;
  };
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
  assert.equal(h.requests.length, 0);
});
