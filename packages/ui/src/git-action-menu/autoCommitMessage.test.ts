import assert from "node:assert/strict";
import test from "node:test";
import type { GitFileChange, GitRepositorySummary } from "@lcode/shared";
import type { ConversationRow } from "@lcode/shared/lcode-protocol-v4";
import {
  advanceAutoGitCommitMessageGate,
  buildGitCommitMessageConversationContext,
  createAutoGitCommitMessageGateState,
  resolveLatestCompletedGitCommitMessageTurn,
} from "./autoCommitMessage.js";
import { buildGitChangesFingerprint } from "./currentSessionFileScope.js";

const gitSummary: GitRepositorySummary = {
  workspacePath: "C:/repo/packages/ui",
  repoRoot: "C:/repo",
  workspaceInRepoPath: "packages/ui",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: "origin/main",
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};

function completedHeader(overrides: Record<string, unknown> = {}): ConversationRow {
  return {
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
    fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" },
    ...overrides,
  } as unknown as ConversationRow;
}

function fileChange(overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path: "C:/repo/packages/ui/src/view.tsx",
    repoRelativePath: "packages/ui/src/view.tsx",
    workspaceRelativePath: "src/view.tsx",
    kind: "modified",
    section: "unstaged",
    added: 3,
    removed: 1,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    ...overrides,
  };
}

test("auto commit message gate requires a live running edge and settled success", () => {
  const completedTurn = resolveLatestCompletedGitCommitMessageTurn([completedHeader()]);
  assert.ok(completedTurn);

  const cold = advanceAutoGitCommitMessageGate(createAutoGitCommitMessageGateState(), {
    enabled: true,
    scopeKey: "workspace/session",
    logEpoch: "epoch-1",
    phase: "completedSuccess",
    settled: true,
    completedTurn,
  });
  assert.equal(cold.target, undefined);

  const running = advanceAutoGitCommitMessageGate(cold.state, {
    enabled: true,
    scopeKey: "workspace/session",
    logEpoch: "epoch-1",
    phase: "running",
    settled: false,
    completedTurn: null,
  });
  assert.equal(running.state.armed, true);
  assert.equal(running.target, null);

  const waiting = advanceAutoGitCommitMessageGate(running.state, {
    enabled: true,
    scopeKey: "workspace/session",
    logEpoch: "epoch-1",
    phase: "completedSuccess",
    settled: false,
    completedTurn,
  });
  assert.equal(waiting.state.armed, true);
  assert.equal(waiting.target, undefined);

  const settled = advanceAutoGitCommitMessageGate(waiting.state, {
    enabled: true,
    scopeKey: "workspace/session",
    logEpoch: "epoch-1",
    phase: "completedSuccess",
    settled: true,
    completedTurn,
  });
  assert.equal(settled.state.armed, false);
  assert.equal(settled.target?.rowTarget.rowId, 10);
  assert.match(settled.target?.key ?? "", /epoch-1/);

  const repeated = advanceAutoGitCommitMessageGate(settled.state, {
    enabled: true,
    scopeKey: "workspace/session",
    logEpoch: "epoch-1",
    phase: "completedSuccess",
    settled: true,
    completedTurn,
  });
  assert.equal(repeated.target, undefined);
});

test("auto commit message gate clears on disable and scope change", () => {
  const armed = advanceAutoGitCommitMessageGate(createAutoGitCommitMessageGateState(), {
    enabled: true,
    scopeKey: "workspace/session-a",
    phase: "running",
    settled: false,
    completedTurn: null,
  });
  const disabled = advanceAutoGitCommitMessageGate(armed.state, {
    enabled: false,
    scopeKey: "workspace/session-a",
    phase: "completedSuccess",
    settled: true,
    completedTurn: resolveLatestCompletedGitCommitMessageTurn([completedHeader()]),
  });
  assert.deepEqual(disabled.state, { scopeKey: "workspace/session-a", armed: false });
  assert.equal(disabled.target, null);

  const switched = advanceAutoGitCommitMessageGate(armed.state, {
    enabled: true,
    scopeKey: "workspace/session-b",
    phase: "completedSuccess",
    settled: true,
    completedTurn: resolveLatestCompletedGitCommitMessageTurn([completedHeader()]),
  });
  assert.equal(switched.state.armed, false);
  assert.equal(switched.target, undefined);
});

test("completed turn must have active file changes and a stable identity", () => {
  assert.equal(
    resolveLatestCompletedGitCommitMessageTurn([
      completedHeader({ fileChanges: { additions: 0, deletions: 0, files: 0 } }),
    ]),
    null,
  );
  assert.equal(
    resolveLatestCompletedGitCommitMessageTurn([
      completedHeader({ fileChanges: { additions: 1, deletions: 0, files: 1, state: "reverted" } }),
    ]),
    null,
  );
  assert.equal(
    resolveLatestCompletedGitCommitMessageTurn([completedHeader({ entityId: undefined })]),
    null,
  );
});

test("conversation context preserves user and assistant intent through the target turn", () => {
  const rows = [
    {
      kind: "userInput",
      rowId: 1,
      entityId: "user-1",
      turnId: "turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      text: "修复登录失败",
      origin: "realUser",
    },
    {
      kind: "assistantText",
      rowId: 2,
      entityId: "assistant-1",
      turnId: "turn-1",
      createdAt: 2,
      createdAtSeq: 2,
      state: "complete",
      text: "已修复登录重试逻辑。",
    },
    completedHeader(),
  ] as unknown as ConversationRow[];

  assert.deepEqual(buildGitCommitMessageConversationContext(rows, "session-1", "turn-1"), {
    sessionId: "session-1",
    messages: [
      { role: "user", content: "修复登录失败" },
      { role: "assistant", content: "已修复登录重试逻辑。" },
    ],
  });
});

test("git fingerprint is scoped, order-independent, and invalidated by staged state", () => {
  const relevant = fileChange();
  const unrelated = fileChange({
    path: "C:/repo/packages/server/src/server.ts",
    repoRelativePath: "packages/server/src/server.ts",
    workspaceRelativePath: "../server/src/server.ts",
    added: 20,
  });
  const options = {
    currentSessionFilePaths: ["src/view.tsx"],
    gitSummary,
    workspacePath: "C:/repo/packages/ui",
  };

  const first = buildGitChangesFingerprint({ files: [relevant, unrelated], ...options });
  const reordered = buildGitChangesFingerprint({ files: [unrelated, relevant], ...options });
  const staged = buildGitChangesFingerprint({
    files: [
      fileChange({
        section: "staged",
        isStaged: true,
      }),
      unrelated,
    ],
    ...options,
  });

  assert.ok(first);
  assert.equal(reordered, first);
  assert.notEqual(staged, first);
  assert.equal(
    buildGitChangesFingerprint({
      files: [unrelated],
      ...options,
    }),
    null,
  );
  assert.equal(
    buildGitChangesFingerprint({
      files: [relevant],
      ...options,
      currentSessionFilePaths: [],
    }),
    null,
  );
});
