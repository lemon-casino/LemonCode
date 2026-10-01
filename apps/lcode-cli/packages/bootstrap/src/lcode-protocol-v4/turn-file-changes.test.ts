// 自动生成 Git 提交信息（specs/git-auto-commit-message.md）依赖的前置事实链：
// CLI 在完成步（无工具调用的模型步）ModelComplete 携带跨步累积的 fileChanges 摘要，
// 本投影必须把它落到 turnHeader.fileChanges（state=active），UI 闸门据此判定“完成轮有文件改动”。
// 注意语义：fileChanges 以“模型步”为单位发射，带工具调用的中间步不携带、
// 由最后一个无工具调用步统一携带本轮累积摘要；不要把“轮内出现过工具调用”误判为链路断裂。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import { ProductProjection } from "./product-projection.js";

function makeEvent(
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent {
  return {
    id: `event-${sequenceNumber}` as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    turnId: "turn-1" as SessionEvent["turnId"],
    type,
    timestamp: new Date(sequenceNumber),
    traceId: "trace-1" as SessionEvent["traceId"],
    sequenceNumber,
    payload,
  };
}

function applyCompletedToolTurn(input: {
  projection: ProductProjection;
  modelCompleteFileChanges?: {
    additions: number;
    deletions: number;
    files: number;
    items: [];
  };
  finalToolCallCount: number;
}): void {
  const { projection } = input;
  projection.applyEvent(
    makeEvent(1, SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "创建一个测试文件",
      messageId: "msg-user-1",
      inputId: "input-1",
    }),
  );
  // 中间步：带工具调用，从不携带 fileChanges（与 CLI 发射语义一致）。
  projection.applyEvent(
    makeEvent(2, SessionEventType.ModelComplete, {
      content: "",
      querySource: "main_turn",
      stopReason: "tool-calls",
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      toolCallCount: 1,
    }),
  );
  if (input.modelCompleteFileChanges) {
    projection.applyEvent(
      makeEvent(3, SessionEventType.ModelComplete, {
        content: "已完成",
        querySource: "main_turn",
        stopReason: "stop",
        usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
        toolCallCount: input.finalToolCallCount,
        fileChanges: input.modelCompleteFileChanges,
      }),
    );
  }
  projection.applyEvent(
    makeEvent(4, SessionEventType.TurnComplete, {
      response: "已完成",
      tokenCount: 140,
      toolCallCount: 1,
      duration: 1000,
      resultType: "success",
    }),
  );
}

function turnHeaderRow(projection: ProductProjection) {
  const row = projection
    .getSnapshot()
    .rows.window.find((candidate) => candidate.kind === "turnHeader");
  assert.ok(row && row.kind === "turnHeader", "turnHeader row must exist");
  return row;
}

test("完成轮 ModelComplete 携带 fileChanges 时投影到 turnHeader 并满足自动提交信息闸门前置", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  applyCompletedToolTurn({
    projection,
    finalToolCallCount: 0,
    modelCompleteFileChanges: {
      additions: 1,
      deletions: 0,
      files: 1,
      items: [],
    },
  });

  const header = turnHeaderRow(projection);
  assert.equal(header.state, "completedSuccess");
  assert.ok(header.entityId, "自动提交信息闸门要求 turnHeader 携带 entityId");
  assert.deepEqual(header.fileChanges, {
    additions: 1,
    deletions: 0,
    files: 1,
    state: "active",
  });
});

test("中间工具步的 ModelComplete 不携带 fileChanges 时不得误设 turnHeader 文件摘要", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.applyEvent(
    makeEvent(1, SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "创建一个测试文件",
      messageId: "msg-user-1",
    }),
  );
  const deltas = projection.applyEvent(
    makeEvent(2, SessionEventType.ModelComplete, {
      content: "",
      querySource: "main_turn",
      stopReason: "tool-calls",
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      toolCallCount: 1,
    }),
  );
  assert.deepEqual(
    deltas.filter((delta) => delta.op === "row.upserted" && delta.row.kind === "turnHeader"),
    [],
  );
  assert.equal(turnHeaderRow(projection).fileChanges, undefined);
});

test("files 为 0 的 fileChanges 不投影，避免空摘要触发自动提交信息", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  applyCompletedToolTurn({
    projection,
    finalToolCallCount: 0,
    modelCompleteFileChanges: {
      additions: 0,
      deletions: 0,
      files: 0,
      items: [],
    },
  });
  assert.equal(turnHeaderRow(projection).fileChanges, undefined);
});
