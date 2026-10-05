import assert from "node:assert/strict";
import test from "node:test";
import type { TurnHeaderRow } from "@lcode/shared/lcode-protocol-v4";
import {
  buildGitLastTurnDataset,
  findLastCompletedAgentTurn,
  readLastCompletedAgentTurn,
  findReviewTurnHeader,
} from "./gitLastTurn.js";

function header(rowId: number, state: TurnHeaderRow["state"], files = 48): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId,
    turnId: `turn-${rowId}`,
    entityId: `entity-${rowId}`,
    createdAt: 1,
    createdAtSeq: rowId,
    startedAt: 1,
    origin: "userInput",
    state,
    fileChanges: { files, additions: 3236, deletions: 194 },
  };
}

test("最新结束轮次覆盖旧轮；运行轮与 controlOnly 不覆盖，空轮不能回退到旧 48 文件", () => {
  const previous = header(1, "completedSuccess");
  const running = header(4, "running");
  assert.equal(findLastCompletedAgentTurn([previous, running]), previous);
  const empty = header(3, "completedSuccess", 0);
  assert.equal(findLastCompletedAgentTurn([previous, empty, running]), empty);
  assert.equal(
    findLastCompletedAgentTurn([previous, { ...empty, executionKind: "controlOnly" }, running]),
    previous,
  );
  assert.equal(findLastCompletedAgentTurn([running]), null);
});

test("冷尾窗分段寻找已结束轮，不把当前运行轮或更旧非空轮当结果", async () => {
  const calls: number[] = [];
  const found = await readLastCompletedAgentTurn({
    sessionId: "session",
    logEpoch: "epoch",
    rows: [header(20, "running")],
    hasMore: true,
    cancelled: () => false,
    rowsRange: async ({ beforeRowId }) => {
      calls.push(beforeRowId!);
      return {
        rows: beforeRowId === 20 ? [header(10, "running")] : [header(2, "completedSuccess", 0)],
        hasMore: true,
        atLogEpoch: "epoch",
        atRevision: 1,
        atSeq: 1,
      };
    },
  });
  assert.equal(found?.rowId, 2);
  assert.deepEqual(calls, [20, 10]);
});

test("历史 patch 不读取当前工作文件，Windows 相对路径正确，撤销不展示旧文件", () => {
  const details = {
    files: 1,
    additions: 1,
    deletions: 1,
    items: [
      {
        path: "C:\\repo\\a.txt",
        additions: 1,
        deletions: 1,
        writeCount: 1,
        toolNames: ["Edit"],
        patches: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+historical"] },
        ],
      },
    ],
  };
  const data = buildGitLastTurnDataset("C:\\repo", details);
  assert.equal(data.readonly, true);
  assert.equal(data.sections[0]?.changes[0]?.workspaceRelativePath, "a.txt");
  assert.match(data.sections[0]!.changes[0]!.diff!.patch!, /\+historical/);
  assert.equal(
    buildGitLastTurnDataset("C:\\repo", { ...details, state: "reverted" }).sections.length,
    0,
  );
});

test("历史分页不拼接其它纪元，取消后不继续读；指定轮次同步撤销状态", async () => {
  const rows = [header(20, "running")];
  const options = {
    sessionId: "session",
    logEpoch: "epoch",
    rows,
    hasMore: true,
    cancelled: () => false,
    rowsRange: async () => ({
      rows: [header(1, "completedSuccess")],
      hasMore: false,
      atLogEpoch: "other-epoch",
      atSeq: 1,
      atRevision: 1,
    }),
  };
  await assert.rejects(readLastCompletedAgentTurn(options), /history changed/);
  assert.equal(await readLastCompletedAgentTurn({ ...options, cancelled: () => true }), null);
  const selected = header(1, "completedSuccess");
  const reverted: TurnHeaderRow = {
    ...selected,
    fileChanges: { files: 48, additions: 1, deletions: 1, state: "reverted" },
  };
  assert.equal(findReviewTurnHeader([reverted, header(4, "completedSuccess")], selected), reverted);
});
