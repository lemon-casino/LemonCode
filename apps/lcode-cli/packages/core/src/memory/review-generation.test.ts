import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ProjectMemoryReviewDraftSchema, type WorkspaceId } from "@lcode/contracts";
import { generateMemoryReviewDraft } from "./review-generation.js";
import {
  fixtureHash,
  oneReviewItem,
  readReviewPrompt,
  reviewHarness,
  reviewMessage,
  reviewSession,
  REVIEW_CURRENT_SESSION,
  REVIEW_FIXTURE_MEMORY_ROOT,
  REVIEW_PAST_SESSION,
} from "./review-test-fixtures.js";

const QUERY = "Review memory design constraints";

test("one frozen no-tool auxiliary request produces a validated read-only draft", async () => {
  const h = reviewHarness();
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.equal(h.requests.length, 1);
  const request = h.requests[0]!;
  assert.deepEqual(request.tools, []);
  assert.equal(request.abortSignal, h.context.abortSignal);
  assert.ok(request.options!.maxOutputTokens! <= 4096);
  assert.equal(request.options!.reasoningLevel, "low");
  assert.ok(Object.isFrozen(request.messages));
  assert.ok(request.messages.every(Object.isFrozen));
  assert.match(String(request.messages[0]!.content), /untrusted/iu);
  assert.equal(h.invocations[0]?.modelRequestSessionType, "other");
  assert.equal(h.invocations[0]?.traceContext?.traceId, h.context.traceId);
  assert.equal(h.invocations[0]?.metadata?.toolCallId, h.context.toolCallId);
  assert.match(draft.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(draft.items[0]!.id, /^item_[a-f0-9]+$/u);
  assert.equal(draft.items[0]!.expectedHash, null);
  assert.ok(h.stats.includes(join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md")));
  assert.deepEqual(ProjectMemoryReviewDraftSchema.parse(draft), draft);
});

test("same path remote identities cannot expose each other's transcripts", async () => {
  const h = reviewHarness();
  const remoteA = "fixture-remote-identity-a" as WorkspaceId;
  const remoteB = "fixture-remote-identity-b" as WorkspaceId;
  h.context.workspaceIdentity = remoteA;
  h.sessions.get(REVIEW_CURRENT_SESSION)!.workspaceID = remoteA;
  h.sessions.get(REVIEW_PAST_SESSION)!.workspaceID = remoteB;
  h.transcripts.set(REVIEW_PAST_SESSION, [
    reviewMessage(REVIEW_PAST_SESSION, "PRIVATE_OTHER_IDENTITY"),
  ]);
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.ok(draft.sources.every((source) => source.reference !== REVIEW_PAST_SESSION));
  assert.ok(!h.snapshots.some((snapshot) => snapshot.sessionID === REVIEW_PAST_SESSION));
  assert.ok(!JSON.stringify(h.requests).includes("PRIVATE_OTHER_IDENTITY"));
  assert.equal(h.lists[0]?.workspaceID, remoteA);
});

test("archived and child sessions, hidden and synthetic messages never become evidence", async () => {
  const h = reviewHarness();
  const hidden = reviewMessage(REVIEW_PAST_SESSION, "HIDDEN_SECRET", "msg_hidden");
  if (hidden.info.role === "user") hidden.info.visibility = "model-only";
  const synthetic = reviewMessage(REVIEW_PAST_SESSION, "SYNTHETIC_SECRET", "msg_synthetic");
  if (synthetic.info.role === "user") synthetic.info.synthetic = true;
  h.transcripts.get(REVIEW_PAST_SESSION)!.push(hidden, synthetic);
  const archived = reviewSession("sess_review_archived" as typeof REVIEW_PAST_SESSION, {
    time: { created: 1, updated: 1, archived: 2 },
  });
  const child = reviewSession("sess_review_child" as typeof REVIEW_PAST_SESSION, {
    taskType: "subagent_child",
    parentID: REVIEW_PAST_SESSION,
  });
  h.sessions.set(archived.id, archived);
  h.sessions.set(child.id, child);
  await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.ok(!JSON.stringify(h.requests).includes("HIDDEN_SECRET"));
  assert.ok(!JSON.stringify(h.requests).includes("SYNTHETIC_SECRET"));
  assert.ok(
    !h.snapshots.some(
      (snapshot) => snapshot.sessionID === child.id || snapshot.sessionID === archived.id,
    ),
  );
});

test("current session requires persisted scope metadata and snapshot capability", async () => {
  for (const missing of ["snapshot", "current", "scope"] as const) {
    const h = reviewHarness();
    if (missing === "snapshot") h.store.readTranscriptSnapshot = undefined;
    if (missing === "current") h.sessions.delete(REVIEW_CURRENT_SESSION);
    if (missing === "scope")
      h.sessions.get(REVIEW_CURRENT_SESSION)!.workspaceID = "other" as WorkspaceId;
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
    assert.equal(h.requests.length, 0);
    assert.equal(h.snapshots.length, 0);
  }
});

test("strict JSON rejects prose, unknown fields, unknown sources and any toolCalls", async () => {
  for (const kind of [
    "prose",
    "unknown-root",
    "unknown-item",
    "unknown-source",
    "tools",
    "fence-prose",
    "length",
  ] as const) {
    const h = reviewHarness();
    h.state.reply = (request) => {
      if (kind === "prose") return { text: 'Here is JSON: {"summary":"x","items":[]}' };
      if (kind === "unknown-root") return { text: '{"summary":"x","items":[],"approved":true}' };
      if (kind === "unknown-item")
        return oneReviewItem(request, { expectedHash: fixtureHash("model fabrication") });
      if (kind === "unknown-source")
        return oneReviewItem(request, { sourceIds: ["source_never_read"] });
      if (kind === "tools")
        return {
          ...oneReviewItem(request),
          toolCalls: [{ id: "forged", name: "Write", input: {} }],
        };
      if (kind === "fence-prose")
        return { text: 'prefix\n```json\n{"summary":"x","items":[]}\n```' };
      return { ...oneReviewItem(request), finishReason: "length" };
    };
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }), kind);
    assert.equal(h.requests.length, 1, kind);
  }
});

test("a complete JSON fence and empty items are accepted without persistence", async () => {
  const h = reviewHarness();
  h.state.reply = () => ({ text: '```json\n{"summary":"Nothing durable","items":[]}\n```' });
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.deepEqual(draft.items, []);
  assert.equal(draft.summary, "Nothing durable");
});

test("targets reject traversal, instructions, indices, skills and platform path aliases", async () => {
  for (const fileName of [
    "../outside.md",
    "/absolute.md",
    "C:/outside.md",
    "a\\b.md",
    "MEMORY.md",
    "memory.md",
    "AGENTS.md",
    "nested/AGENTS.md",
    "skills/x.md",
    ".agents/x.md",
    "nested/../x.md",
    "aux.md",
    "dir./x.md",
    "memory-state/x.md",
  ]) {
    const h = reviewHarness();
    h.state.reply = (request) => oneReviewItem(request, { fileName });
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }), fileName);
    assert.ok(!h.stats.some((path) => path.endsWith("outside.md")), fileName);
  }
});

test("existing target hash comes only from a full trusted read, preserving raw CRLF revision", async () => {
  const h = reviewHarness();
  const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "design.md");
  h.files.set(path, { content: "line1\nline2\n", rawContent: "line1\r\nline2\r\n" });
  h.state.reply = (request) => oneReviewItem(request);
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.equal(draft.items[0]!.expectedHash, fixtureHash("line1\r\nline2\r\n"));
  assert.notEqual(draft.items[0]!.expectedHash, fixtureHash("line1\nline2\n"));
  assert.equal(h.reads.filter((read) => read === path).length, 1);
});

test("unread or truncated existing targets are never expanded after model response", async () => {
  for (const mode of ["unread", "truncated", "noHash"] as const) {
    const h = reviewHarness();
    const target = join(REVIEW_FIXTURE_MEMORY_ROOT, "z-unread.md");
    if (mode === "unread") {
      for (let index = 0; index < 9; index++)
        h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, `memory-${index}.md`), {
          content: "Memory constraint.",
        });
    }
    h.files.set(target, {
      content: "Must not overwrite",
      truncated: mode === "truncated",
      noHash: mode === "noHash",
    });
    h.state.reply = (request) => oneReviewItem(request, { fileName: "z-unread.md" });
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }));
    assert.ok(h.reads.length <= 8);
    if (mode === "unread") {
      assert.ok(!h.reads.includes(target));
      assert.ok(readReviewPrompt(h.requests[0]!).otherMemoryFileNames.includes("z-unread.md"));
    }
  }
});

test("changed evidence content and query produce different stable fingerprints", async () => {
  const h = reviewHarness();
  h.state.reply = (request) => oneReviewItem(request);
  const a = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  const b = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.equal(a.fingerprint, b.fingerprint);
  const c = await generateMemoryReviewDraft({ query: `${QUERY} extra`, context: h.context });
  assert.notEqual(a.fingerprint, c.fingerprint);
  h.transcripts
    .get(REVIEW_PAST_SESSION)!
    .push(reviewMessage(REVIEW_PAST_SESSION, "A changed fact", "msg_change"));
  const d = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  assert.notEqual(a.fingerprint, d.fingerprint);
});

test("pre-abort, model-time abort and abort while a port is pending reject promptly", async () => {
  const before = reviewHarness();
  before.controller.abort(new Error("SECRET_ABORT_REASON"));
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: before.context }), {
    name: "AbortError",
  });
  assert.equal(before.requests.length, 0);
  for (const pending of ["model", "store"] as const) {
    const h = reviewHarness();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    if (pending === "model")
      h.state.reply = () => {
        started();
        return new Promise(() => {});
      };
    else
      h.store.readTranscriptSnapshot = () => {
        started();
        return new Promise(() => {});
      };
    const generation = generateMemoryReviewDraft({ query: QUERY, context: h.context });
    await ready;
    h.controller.abort(new Error("SECRET_ABORT_REASON"));
    await assert.rejects(
      generation,
      (error: Error) => error.name === "AbortError" && !error.message.includes("SECRET"),
    );
  }
});

test("port failures do not expose raw errors", async () => {
  const h = reviewHarness();
  h.store.listSessions = async () => {
    throw new Error("PRIVATE raw database error");
  };
  await assert.rejects(
    generateMemoryReviewDraft({ query: QUERY, context: h.context }),
    (error: Error) => !error.message.includes("PRIVATE"),
  );
  assert.equal(h.requests.length, 0);
});
