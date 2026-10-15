import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import {
  hasStatusBarConversation,
  readStatusBarRequest,
  readStatusBarTotals,
} from "./tokenUsageStatusBarModel.js";

test("新草稿和缺失快照隐藏状态栏，首次请求与分页空窗不误判为新会话", () => {
  assert.equal(hasStatusBarConversation(null, false), false);
  const snapshot = {
    control: { phase: "draft" },
    rows: { window: [], totalCount: 0 },
  } as unknown as ConversationSnapshot;
  assert.equal(hasStatusBarConversation(snapshot, false), false);
  for (const phase of [
    "prewarming",
    "running",
    "completedSuccess",
    "completedInterrupted",
    "error",
  ] as const) {
    snapshot.control.phase = phase;
    assert.equal(hasStatusBarConversation(snapshot, false), true);
    assert.equal(hasStatusBarConversation(snapshot, true), false);
  }
});

test("主/子会话合计不重复加缓存，未知主用量不伪装成完整总量", () => {
  assert.deepEqual(
    readStatusBarTotals(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 10 },
      { inputTokens: 10, outputTokens: 5, unknownCount: 1 },
      50,
    ),
    { own: 120, children: 15, total: 135, partial: true },
  );
  assert.deepEqual(
    readStatusBarTotals(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 10, outputTokens: 5, unknownCount: 0 },
      50,
    ),
    { own: null, children: 15, total: 15, partial: true },
  );
  assert.equal(readStatusBarTotals(undefined, undefined, 0).total, null);
});

test("最近请求必须属于快照当前轮次，非法用量与时长不可展示", () => {
  const snapshot = {
    rows: { window: [{ turnId: "turn-two" }] },
    usage: {
      modelOutput: {
        turnId: "turn-one",
        activeRequestId: null,
        lastRequest: {
          requestId: "request-one",
          outputTokens: 100,
          durationMs: 2000,
          completedAt: 1,
        },
      },
    },
  } as ConversationSnapshot;
  assert.equal(readStatusBarRequest(snapshot), null);
  snapshot.usage.modelOutput!.turnId = "turn-two";
  assert.equal(readStatusBarRequest(snapshot)?.outputTokens, 100);
  snapshot.usage.modelOutput!.lastRequest!.durationMs = 0;
  assert.equal(readStatusBarRequest(snapshot), null);
});
