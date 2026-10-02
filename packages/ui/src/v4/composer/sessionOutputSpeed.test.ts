import assert from "node:assert/strict";
import test from "node:test";
import { combineOutputSpeeds, readSessionOutputSpeed } from "./sessionOutputSpeed.js";

function snapshot(modelOutput: unknown, phase = "running") {
  return {
    control: { phase },
    rows: { window: [{ turnId: "turn-one" }] },
    usage: { modelOutput },
  } as never;
}

function activity(activeRequestId: string | null, completedAt = 100) {
  return {
    turnId: "turn-one",
    activeRequestId,
    lastRequest: { requestId: "request-one", outputTokens: 100, durationMs: 2_000, completedAt },
  };
}

test("请求均速与实时采样分开，结算及工具阶段不再把旧读数当实时", () => {
  assert.deepEqual(readSessionOutputSpeed(snapshot(activity("request-two")), 20), {
    liveRate: 20,
    average: { rate: 50, completedAt: 100 },
    pending: false,
  });
  assert.deepEqual(readSessionOutputSpeed(snapshot(activity(null)), 20), {
    liveRate: null,
    average: { rate: 50, completedAt: 100 },
    pending: false,
  });
  assert.deepEqual(readSessionOutputSpeed(snapshot(activity(null), "completedSuccess"), null), {
    liveRate: null,
    average: { rate: 50, completedAt: 100 },
    pending: false,
  });
});

test("隐藏推理无实时文本时明确等待用量，同时保留上次已结算均速", () => {
  const speed = readSessionOutputSpeed(snapshot(activity("request-two")), null);
  assert.equal(speed.pending, true);
  assert.equal(speed.liveRate, null);
  assert.equal(speed.average?.rate, 50);
  assert.equal(readSessionOutputSpeed(snapshot(undefined), null).pending, true);
  assert.equal(
    readSessionOutputSpeed(snapshot(undefined, "completedSuccess"), null).pending,
    false,
  );
});

test("旧快照保持可见速率兼容，另一轮次和无效账单不能产生均速", () => {
  assert.equal(readSessionOutputSpeed(snapshot(undefined), 20).liveRate, 20);
  assert.equal(readSessionOutputSpeed(null, 20).liveRate, null);
  assert.equal(
    readSessionOutputSpeed(snapshot({ ...activity(null), turnId: "old-turn" }), null).average,
    null,
  );
  for (const lastRequest of [
    { outputTokens: 0, durationMs: 2_000 },
    { outputTokens: -1, durationMs: 2_000 },
    { outputTokens: 100, durationMs: 0 },
    { outputTokens: 100, durationMs: Number.NaN },
    { outputTokens: Number.POSITIVE_INFINITY, durationMs: 2_000 },
  ]) {
    assert.equal(
      readSessionOutputSpeed(snapshot({ ...activity(null), lastRequest }), null).average,
      null,
    );
  }
});

test("并行可见速率可以相加，请求均速只取最近完成的记录", () => {
  const first = readSessionOutputSpeed(snapshot(activity("a", 100)), 20);
  const second = readSessionOutputSpeed(snapshot(activity("b", 200)), 10);
  second.average!.rate = 40;
  assert.deepEqual(combineOutputSpeeds([first, second]), {
    liveRate: 30,
    average: { rate: 40, completedAt: 200 },
    pending: false,
  });
  assert.equal(combineOutputSpeeds([]).liveRate, null);
  assert.equal(combineOutputSpeeds([]).average, null);
  second.pending = true;
  assert.equal(combineOutputSpeeds([first, second]).pending, true);
});
