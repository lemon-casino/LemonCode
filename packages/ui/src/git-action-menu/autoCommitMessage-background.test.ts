import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@lcode/shared/lcode-protocol-v4";
import {
  advanceAutoGitCommitMessageGate,
  areGitCommitBackgroundWorksSettled,
  createAutoGitCommitMessageGateState,
  resolveLatestCompletedGitCommitMessageTurn,
} from "./autoCommitMessage.js";

test("a running preview Bash does not block auto-opening after a live completed turn", () => {
  const works = [
    { workId: "preview", kind: "bash", status: "running" },
    { workId: "old-output", kind: "bash", status: "resultPending" },
  ] as const;
  assert.equal(areGitCommitBackgroundWorksSettled(works), true);
  const completedTurn = resolveLatestCompletedGitCommitMessageTurn([
    {
      kind: "turnHeader",
      rowId: 10,
      entityId: "turn-entity",
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
      endedAt: 2,
      fileChanges: { additions: 1, deletions: 0, files: 1, state: "active" },
    } as ConversationRow,
  ]);
  assert.ok(completedTurn);
  const running = advanceAutoGitCommitMessageGate(createAutoGitCommitMessageGateState(), {
    enabled: true,
    scopeKey: "workspace/session",
    phase: "running",
    settled: false,
    completedTurn: null,
  });
  const finished = advanceAutoGitCommitMessageGate(running.state, {
    enabled: true,
    scopeKey: "workspace/session",
    phase: "completedSuccess",
    settled: areGitCommitBackgroundWorksSettled(works),
    completedTurn,
  });
  assert.ok(finished.target);
  assert.equal(
    areGitCommitBackgroundWorksSettled([{ kind: "workflow", status: "running" }]),
    false,
  );
});
