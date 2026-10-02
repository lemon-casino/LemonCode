import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MEMORY_REVIEW_TOOL_NAME,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  type MessageId,
  type MessageWithParts,
  type SessionInfo,
} from "@lcode/contracts";
import { harness, WORKSPACE, hash } from "./project-memory-extraction.test-support.js";

test("background extraction verifies then commits through the governed port with two fresh no-tool requests", async () => {
  const h = harness();
  h.schedule();
  await h.drain();
  assert.equal(h.errors.length, 0, String(h.errors[0]));
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
  assert.equal(h.saved.length, 1);
  assert.ok(h.saved[0]!.verification?.acceptedItemIds.length);
  assert.equal(h.applied[0]!.itemId, h.saved[0]!.draft.items[0]!.id);
  assert.equal(h.applied[0]!.expectedItemHash, hash(JSON.stringify(h.saved[0]!.draft.items[0])));
  assert.deepEqual(
    h.requests.map((request) => request.messages.map((message) => message.role)),
    [
      ["system", "user"],
      ["system", "user"],
    ],
  );
  assert.notEqual(h.requests[0]!.messages, h.requests[1]!.messages);
  assert.ok(h.requests[0]!.options!.maxOutputTokens! <= 1536);
  assert.ok(h.requests[1]!.options!.maxOutputTokens! <= 768);
  assert.equal(h.saved[0]!.draft.sources.filter((source) => source.kind === "session").length, 1);
  assert.equal(h.saved[0]!.draft.sources[0]!.boundaryMessageId, h.boundary);
  assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), h.boundary);
  assert.deepEqual(h.outcomes, ["completed"]);
});

test("AI rejection and empty candidates do not apply changes and consume the successful evidence boundary", async () => {
  for (const empty of [false, true]) {
    const h = harness();
    if (empty) h.empty();
    else h.reject();
    h.schedule();
    await h.drain();
    assert.equal(h.requests.length, empty ? 1 : 2);
    assert.equal(h.applied.length, 0);
    assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), h.boundary);
    assert.deepEqual(h.outcomes, ["completed"]);
  }
});

test("conflicts and model errors report failed telemetry, retain cursor and never retry in a loop", async () => {
  for (const conflict of [false, true]) {
    const h = harness();
    if (conflict) h.setConflict(true);
    else h.failModel();
    h.schedule();
    await h.drain();
    assert.equal(h.requests.length, conflict ? 2 : 1);
    assert.equal(h.applied.length, conflict ? 1 : 0);
    assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), undefined);
    assert.deepEqual(h.outcomes, ["failed"]);
  }
});

test("disabled memory/extraction or missing capabilities never invokes fallback memory agents", async () => {
  for (const unavailable of ["disabled", "off", "projectMemory", "window"] as const) {
    const h = harness();
    if (unavailable === "disabled") h.runtime.config.memory!.extractionEnabled = false;
    if (unavailable === "off") h.runtime.config.memory!.enabled = false;
    if (unavailable === "projectMemory") delete h.fileSystem.projectMemory;
    if (unavailable === "window") delete h.store.readTranscriptWindow;
    h.schedule();
    await h.drain();
    assert.equal(h.requests.length, 0);
    assert.equal(h.saved.length, 0);
    assert.equal(h.applied.length, 0);
    assert.equal(h.readMessages(), 0);
    assert.equal(h.snapshotReads(), 0);
    assert.equal(h.sessionReads(), 0);
    assert.equal(h.windowInputs.length, 0);
  }
});

test("valid prefix-truncated windows admit recent completed evidence without whole-history fallback", async () => {
  const h = harness();
  h.patchWindow({ prefixTruncated: true });
  delete h.store.readTranscriptSnapshot;
  h.schedule();
  await h.drain();
  assert.equal(h.errors.length, 0, String(h.errors[0]));
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
  assert.equal(h.readMessages(), 0);
  assert.equal(h.snapshotReads(), 0);
  assert.ok(h.windowInputs.length > 0);
  assert.ok(h.windowInputs.every((input) => input.throughMessageID === h.boundary));
});

test("invalid completed windows are skipped before model or metadata fallback reads", async () => {
  for (const invalid of [
    "missing",
    "through",
    "truncated",
    "session",
    "session-id",
    "workspace",
    "no-user",
    "synthetic",
    "model-only",
    "part-synthetic",
  ] as const) {
    const h = harness();
    if (invalid === "missing") h.patchWindow({ boundaryFound: false });
    if (invalid === "through") h.patchWindow({ throughMessageID: "msg_other" as MessageId });
    if (invalid === "truncated") h.patchWindow({ truncated: true });
    if (invalid === "session") h.patchWindow({ session: null });
    if (invalid === "session-id")
      h.patchWindow({ session: { ...h.session, id: "sess_foreign" as SessionInfo["id"] } });
    if (invalid === "workspace")
      h.patchWindow({ session: { ...h.session, directory: resolve("other-window-workspace") } });
    if (invalid === "no-user") h.durable[0]!.info.role = "assistant";
    if (invalid === "synthetic" && h.durable[0]!.info.role === "user")
      h.durable[0]!.info.synthetic = true;
    if (invalid === "model-only" && h.durable[0]!.info.role === "user")
      h.durable[0]!.info.visibility = "model-only";
    if (invalid === "part-synthetic" && h.durable[0]!.parts[0]!.type === "text")
      h.durable[0]!.parts[0]!.synthetic = true;
    h.schedule();
    await h.drain();
    assert.equal(h.windowInputs.length, 1, invalid);
    assert.equal(h.requests.length, 0, invalid);
    assert.equal(h.sessionReads(), 0, invalid);
    assert.equal(h.readMessages(), 0, invalid);
    assert.equal(h.snapshotReads(), 0, invalid);
    assert.equal(h.runtime.memoryExtractionScheduler?.getCursor(), undefined, invalid);
  }
});

test("an oversized earlier history does not hide the recent user turn in a completed window", async () => {
  const h = harness();
  const historical = Array.from(
    { length: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS + 20 },
    (_, index) => {
      const id = `msg_earlier_${index}` as MessageId;
      return {
        info: { ...h.durable[0]!.info, id, time: { created: 0 } },
        parts: [
          {
            id: `part_earlier_${index}`,
            sessionID: h.session.id,
            messageID: id,
            type: "text",
            text: "old unrelated turn",
          },
        ],
      } as MessageWithParts;
    },
  );
  h.durable.unshift(...historical);
  h.schedule();
  await h.drain();
  assert.equal(h.errors.length, 0, String(h.errors[0]));
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
  assert.doesNotMatch(
    JSON.stringify(h.requests.map((request) => request.messages)),
    /old unrelated turn/u,
  );
  assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), h.boundary);
  assert.equal(h.readMessages(), 0);
  assert.equal(h.snapshotReads(), 0);
});

test("scheduler uses atomic window metadata to reject a missing active-branch boundary", async () => {
  const h = harness();
  h.patchWindow({
    session: {
      ...h.session,
      revert: {
        kind: "checkpoint",
        targetMessageID: "msg_removed",
        keptMessageIDs: [],
        branchCutAfterMessageID: "msg_removed",
      },
    } as SessionInfo,
  });
  h.schedule();
  await h.drain();
  assert.equal(h.requests.length, 0);
  assert.equal(h.sessionReads(), 0);
  assert.equal(h.readMessages(), 0);
});

test("shutdown after generation prevents verification, persistence and apply", async () => {
  const h = harness();
  h.onModel(() => h.runtime.memoryExtractionScheduler!.shutdown());
  h.schedule();
  await h.drain();
  assert.equal(h.requests.length, 1);
  assert.equal(h.saved.length, 0);
  assert.equal(h.applied.length, 0);
  assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), undefined);
  assert.deepEqual(h.outcomes, ["cancelled"]);
});

test("automatic evidence never learns foreground review proposals or their derived summaries", async () => {
  const h = harness();
  const sessionID = h.session.id;
  h.durable.unshift(
    {
      info: { id: "msg_foreground_review", sessionID, role: "assistant" },
      parts: [
        {
          id: "part_foreground_review",
          sessionID,
          messageID: "msg_foreground_review",
          type: "tool",
          tool: MEMORY_REVIEW_TOOL_NAME,
          callID: "call_foreground_review",
          state: { status: "error", input: { action: "read" }, error: "discarded-proposal-secret" },
        },
      ],
    } as MessageWithParts,
    {
      info: { id: "msg_foreground_answer", sessionID, role: "assistant" },
      parts: [
        {
          id: "part_foreground_answer",
          sessionID,
          messageID: "msg_foreground_answer",
          type: "text",
          text: "discarded-proposal-secret in answer",
        },
      ],
    } as MessageWithParts,
    {
      info: {
        id: "msg_derived_summary",
        sessionID,
        role: "user",
        summary: { body: "discarded-proposal-secret", diffs: [] },
      },
      parts: [
        {
          id: "part_derived_summary",
          sessionID,
          messageID: "msg_derived_summary",
          type: "text",
          text: "discarded-proposal-secret",
          synthetic: true,
        },
        {
          id: "part_derived_boundary",
          sessionID,
          messageID: "msg_derived_summary",
          type: "compaction",
        },
      ],
    } as MessageWithParts,
  );
  h.schedule();
  await h.drain();
  assert.equal(h.errors.length, 0, String(h.errors[0]));
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
  assert.doesNotMatch(
    JSON.stringify(h.requests.map((request) => request.messages)),
    /discarded-proposal-secret/u,
  );
  assert.match(JSON.stringify(h.requests[0]!.messages), /deterministic fixture tests/u);
});

test("later foreground text and session model/config changes cannot alter the frozen background boundary", async () => {
  const h = harness();
  h.schedule();
  const futureId = "msg_future" as MessageId;
  h.durable.push({
    info: {
      id: futureId,
      sessionID: h.session.id,
      role: "user",
      time: { created: 2 },
      agent: "build",
    },
    parts: [
      {
        id: "part_future",
        sessionID: h.session.id,
        messageID: futureId,
        type: "text",
        text: "future-private-fact",
      },
    ],
  } as MessageWithParts);
  h.runtime.latestConversationMessageId = futureId;
  h.runtime.workingDirectory = join(WORKSPACE, "changed-cwd");
  h.runtime.config.memory!.workspaceIdentity = "other-workspace";
  h.runtime.modelFactory = () => {
    throw new Error("must use captured model");
  };
  await h.drain();
  assert.equal(h.errors.length, 0, String(h.errors[0]));
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
  assert.doesNotMatch(
    JSON.stringify(h.requests.map((request) => request.messages)),
    /future-private-fact/u,
  );
  assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), h.boundary);
});
