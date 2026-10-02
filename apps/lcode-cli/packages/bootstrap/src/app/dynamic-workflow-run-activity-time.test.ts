import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJournalStore, type RunEvent } from "@lcode/dynamic-workflow";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { replayRunProgressFromEvents } from "./dynamic-workflow-run-replay.js";

test("活动投影的 live 和冷回放沿用 journal 原时间", () => {
  const event: RunEvent = {
    type: "node-settled",
    instance: { siteId: "ask#1", ordinal: 1 },
    outcome: "ok",
  };
  const live = toProgressPayload({ runId: "run-one", sequence: 3, occurredAt: 1_500, event });
  const replay = replayRunProgressFromEvents(
    { runId: "run-one", status: "running" } as Parameters<typeof replayRunProgressFromEvents>[0],
    [{ sequence: 3, event, timeCreated: 1_500 }],
    8,
  );
  assert.equal(live.occurredAt, 1_500);
  assert.deepEqual(replay, [live]);
  const old = toProgressPayload({ runId: "run-one", sequence: 3, event });
  assert.equal(old.occurredAt, undefined);
});

test("序号捕获只读取同一条已落库事件的源时间", () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: "run-one",
    status: "running",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
  });
  const capture = createJournalSequenceCapture(journal);
  const event: RunEvent = { type: "log", message: "checking" };
  const stored = capture.journal.appendEvent("run-one", event);
  assert.equal(capture.sequenceOf(event), stored.sequence);
  assert.equal(capture.timeOf(event), stored.timeCreated);
  assert.equal(capture.timeOf({ ...event }), undefined);
});
