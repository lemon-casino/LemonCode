import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationRow,
  V4ConversationFileChangesResult,
} from "@lcode/shared/lcode-protocol-v4";
import {
  collectSessionCommitFilePaths,
  type SessionCommitFileReader,
} from "./sessionCommitMessageFiles.js";
import { canGenerateSessionCommitSummary } from "./autoCommitMessage.js";

function header(rowId: number, reverted = false): ConversationRow {
  return {
    kind: "turnHeader",
    rowId,
    entityId: `turn-${rowId}`,
    turnId: `turn-${rowId}`,
    createdAt: 1,
    createdAtSeq: 1,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    fileChanges: { files: 1, additions: 1, deletions: 0, state: reverted ? "reverted" : "active" },
  } as ConversationRow;
}
function changes(path: string, reverted = false): V4ConversationFileChangesResult {
  return {
    files: 1,
    additions: 1,
    deletions: 0,
    state: reverted ? "reverted" : "active",
    items: [{ path, additions: 1, deletions: 0, writeCount: 1, toolNames: ["Edit"], patches: [] }],
  };
}

test("父会话、工作流子会话与分页历史均按各自 revision 读取；不读取其它会话", async () => {
  const queried: string[] = [];
  const reader: SessionCommitFileReader = {
    async rowsRange({ sessionId, beforeRowId }) {
      queried.push(sessionId);
      return {
        rows: sessionId === "root" ? [header(beforeRowId ? 1 : 10)] : [header(20)],
        atRevision: sessionId === "root" ? 11 : 22,
        atLogEpoch: sessionId,
        atSeq: 1,
        hasMore: sessionId === "root" && !beforeRowId,
      };
    },
    async fileChanges({ sessionId, target, baseRevision, baseLogEpoch }) {
      assert.equal(baseRevision, sessionId === "root" ? 11 : 22);
      assert.equal(baseLogEpoch, sessionId);
      return changes(sessionId === "root" ? `root-${target.rowId}.ts` : "workflow.ts");
    },
  };
  assert.deepEqual(
    await collectSessionCommitFilePaths(reader, ["root", "actor", "actor"], () => true),
    ["root-1.ts", "root-10.ts", "workflow.ts"],
  );
  assert.deepEqual(queried.sort(), ["actor", "root", "root"]);
});

test("不把回滚轮次、无修改轮次或已回滚文件详情作为证据", async () => {
  let count = 0;
  const reader: SessionCommitFileReader = {
    async rowsRange() {
      return {
        rows: [header(1, true), { ...header(2), fileChanges: undefined }, header(3)],
        atRevision: 1,
        atLogEpoch: "epoch",
        atSeq: 1,
        hasMore: false,
      };
    },
    async fileChanges() {
      count++;
      return changes("reverted.ts", true);
    },
  };
  assert.deepEqual(await collectSessionCommitFilePaths(reader, ["root"], () => true), []);
  assert.equal(count, 1);
});

test("分页期间换代或游标不前进时拒绝混合范围", async () => {
  let count = 0;
  const reader: SessionCommitFileReader = {
    async rowsRange() {
      return {
        rows: [header(10)],
        atRevision: 1,
        atLogEpoch: `epoch-${++count}`,
        atSeq: 1,
        hasMore: true,
      };
    },
    async fileChanges() {
      return changes("a.ts");
    },
  };
  await assert.rejects(
    collectSessionCommitFilePaths(reader, ["root"], () => true),
    /scope_changed/,
  );
  reader.rowsRange = async () => ({
    rows: [header(10)],
    atRevision: 1,
    atLogEpoch: "epoch",
    atSeq: 1,
    hasMore: true,
  });
  await assert.rejects(
    collectSessionCommitFilePaths(reader, ["root"], () => true),
    /cursor_invalid/,
  );
});

test("切换会话后迟到的详情不能发布文件范围", async () => {
  let alive = true;
  const reader: SessionCommitFileReader = {
    async rowsRange() {
      return { rows: [header(1)], atRevision: 1, atLogEpoch: "epoch", atSeq: 1, hasMore: false };
    },
    async fileChanges() {
      alive = false;
      return changes("a.ts");
    },
  };
  assert.deepEqual(await collectSessionCommitFilePaths(reader, ["root"], () => alive), []);
});

test("手动入口仍受自动提交设置、终态、仓库与会话权限控制", () => {
  const input = {
    enabled: true,
    sessionId: "root",
    readOnly: false,
    sideChat: false,
    phase: "completedSuccess" as const,
    repositoryAvailable: true,
    repositoryDirty: true,
  };
  assert.equal(canGenerateSessionCommitSummary(input), true);
  for (const patch of [
    { enabled: false },
    { sessionId: null },
    { readOnly: true },
    { sideChat: true },
    { phase: "running" as const },
    { repositoryAvailable: false },
    { repositoryDirty: false },
  ]) {
    assert.equal(canGenerateSessionCommitSummary({ ...input, ...patch }), false);
  }
});
