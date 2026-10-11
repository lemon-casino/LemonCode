import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  type MessageWithParts,
  type SessionTranscriptWindow,
} from "@lcode/contracts";
import { collectReviewSessionEvidence } from "./review-session-evidence.js";
import { reviewHarness, reviewMessage, REVIEW_CURRENT_SESSION } from "./review-test-fixtures.js";

function nearLimitHarness() {
  const h = reviewHarness();
  const old = reviewMessage(REVIEW_CURRENT_SESSION, "Old response", "msg_old");
  old.info = { ...old.info, role: "assistant" } as MessageWithParts["info"];
  old.parts = Array.from({ length: 100 }, (_, index) => ({
    id: `part_${index}_${"i".repeat(60)}`,
    sessionID: REVIEW_CURRENT_SESSION,
    messageID: old.info.id,
    type: "text",
    text: "x".repeat(2500),
  })) as MessageWithParts["parts"];
  const user = reviewMessage(REVIEW_CURRENT_SESSION, "Durable current fixture fact", "msg_user");
  const done = reviewMessage(REVIEW_CURRENT_SESSION, "Confirmed fixture fact", "msg_done");
  done.info = { ...done.info, role: "assistant" } as MessageWithParts["info"];
  const messages = [old, user, done];
  // 模拟真实SQLite数据列：行ID在读取时注入，不在data JSON预算内。
  const rawBytes = messages.reduce((sum, message) => {
    const { id: _id, sessionID: _session, ...data } = message.info;
    return (
      sum +
      Buffer.byteLength(JSON.stringify(data)) +
      message.parts.reduce((total, part) => {
        const { id: _part, sessionID: _scope, messageID: _message, ...payload } = part;
        return total + Buffer.byteLength(JSON.stringify(payload));
      }, 0)
    );
  }, 0);
  assert.ok(rawBytes < SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES);
  assert.ok(
    Buffer.byteLength(JSON.stringify(messages)) > SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  );
  const window: SessionTranscriptWindow = {
    session: h.sessions.get(REVIEW_CURRENT_SESSION)!,
    messages,
    loadedMessageCount: messages.length,
    loadedPartCount: messages.reduce((sum, message) => sum + message.parts.length, 0),
    loadedDataBytes: rawBytes,
    truncated: false,
    throughMessageID: done.info.id,
    boundaryFound: true,
    prefixTruncated: false,
  };
  h.store.readTranscriptWindow = async () => structuredClone(window);
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: done.info.id };
  return { ...h, window };
}

test("admitted raw payload stays usable when injected row identities exceed the raw byte limit", async () => {
  const h = nearLimitHarness();
  const evidence = await collectReviewSessionEvidence(h.context);
  assert.equal(evidence.materials.length, 1);
  assert.match(evidence.materials[0]!.content, /Durable current fixture fact/u);
  assert.doesNotMatch(evidence.materials[0]!.content, /Old response/u);
});

test("raw byte reporting cannot hide oversized payload or inconsistent row counts", async () => {
  for (const invalid of [
    "payload",
    "bytes",
    "message-count",
    "part-count",
    "negative",
    "fraction",
  ] as const) {
    const h = nearLimitHarness();
    if (invalid === "payload") {
      const part = h.window.messages[0]!.parts[0]!;
      if (part.type === "text") part.text = "x".repeat(SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES);
    }
    if (invalid === "bytes") h.window.loadedDataBytes = 1;
    if (invalid === "message-count") h.window.loadedMessageCount = 1;
    if (invalid === "part-count") h.window.loadedPartCount = 1;
    if (invalid === "negative") h.window.loadedDataBytes = -1;
    if (invalid === "fraction") h.window.loadedDataBytes += 0.5;
    await assert.rejects(
      collectReviewSessionEvidence(h.context),
      { code: "budget_exceeded" },
      invalid,
    );
  }
});
