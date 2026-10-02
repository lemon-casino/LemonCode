import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkflowRunsState } from "./workflow-runs-reducer.js";
import { workflowRunNodeSchema, type WorkflowRunsState } from "./workflow-runs.js";

const original = { siteId: "ask#1", ordinal: 1 };
const activity = {
  kind: "model" as const,
  observedAt: 1_100,
  since: 1_100,
  requestsCompleted: 0,
  toolCalls: 0,
  requestId: "request-one",
};

function fixture() {
  let state: WorkflowRunsState | undefined;
  let sequence = 0;
  const send = (eventType: string, payload: Record<string, unknown>, occurredAt?: number) => {
    state =
      reduceWorkflowRunsState(state, {
        runId: "run-one",
        sequence: ++sequence,
        eventType,
        payload,
        ...(occurredAt === undefined ? {} : { occurredAt }),
      }) ?? state;
  };
  send("run-started", {});
  send("node-queued", { instance: original, kind: "ask" }, 1_000);
  send("node-dispatched", { instance: original }, 1_050);
  return {
    send,
    state: () => state!,
    node: () => state!.runs[0]!.nodes[0]!,
  };
}

test("活动可以在首轮返回前更新，不改变生命周期或交付计数", () => {
  const f = fixture();
  f.send("node-activity", { instance: original, activity });
  assert.deepEqual(f.node().activity, activity);
  assert.equal(f.node().phase, "dispatched");
  assert.equal(f.node().turn, undefined);
  assert.equal(f.node().settledAt, undefined);
  assert.equal(f.state().runs[0]!.usage.nodesUsed, 1);
  f.send("node-progress", { instance: original, turn: 1, toolCalls: 4 });
  f.send("node-executing", { instance: original });
  assert.deepEqual(f.node().activity, activity);
});

test("等待包含源时间与首次重试时间，成功恢复清除等待", () => {
  const f = fixture();
  f.send(
    "node-waiting",
    {
      instance: original,
      cause: "backoff",
      reason: "network_error",
      attempt: 2,
      delayMs: 2_000,
    },
    2_000,
  );
  assert.deepEqual(f.node().wait, {
    cause: "backoff",
    reason: "network_error",
    attempt: 2,
    since: 2_000,
    nextRetryAt: 4_000,
  });
  f.send(
    "node-waiting",
    {
      instance: original,
      cause: "backoff",
      reason: "timeout",
      attempt: 3,
      delayMs: 4_000,
    },
    4_100,
  );
  assert.equal(f.node().wait?.since, 2_000);
  assert.equal(f.node().wait?.nextRetryAt, 8_100);
  f.send("node-activity", { instance: original, activity });
  assert.equal(f.node().wait?.cause, "backoff");
  f.send("node-executing", { instance: original }, 8_100);
  assert.equal(f.node().wait, undefined);
  f.send("node-settled", { instance: original, outcome: "ok" }, 8_200);
  assert.equal(f.node().settledAt, 8_200);
});

test("迟到、旧代次、暂停和终态后的活动不得覆盖当前事实", () => {
  const f = fixture();
  f.send("node-activity", { instance: original, activity });
  f.send("node-activity", { instance: original, activity: { ...activity, observedAt: 1_000 } });
  assert.equal(f.node().activity?.observedAt, 1_100);
  f.send("node-paused", { instance: original });
  f.send("node-activity", { instance: original, activity: { ...activity, observedAt: 2_000 } });
  assert.equal(f.node().activity?.observedAt, 1_100);
  f.send("node-retried", { instance: { ...original, attempt: 2 } });
  assert.equal(f.node().activity, undefined);
  f.send("node-activity", { instance: original, activity });
  assert.equal(f.node().activity, undefined);
  const current = { ...original, attempt: 2 };
  f.send("node-activity", { instance: { ...original, attempt: 3 }, activity });
  assert.equal(f.node().activity, undefined);
  f.send("node-activity", { instance: current, activity });
  assert.deepEqual(f.node().activity, activity);
  f.send("node-settled", { instance: current, outcome: "ok" }, 3_000);
  f.send("node-activity", { instance: current, activity: { ...activity, observedAt: 4_000 } });
  assert.equal(f.node().activity?.observedAt, 1_100);
  f.send("run-settled", { status: "completed" });
  f.send("node-activity", { instance: current, activity: { ...activity, observedAt: 5_000 } });
  assert.equal(f.node().activity?.observedAt, 1_100);
});

test("迟到的等待和请求启动不能重新激活暂停或结算节点", () => {
  const f = fixture();
  f.send("node-waiting", { instance: original, cause: "backoff", attempt: 2, delayMs: 200 }, 2_000);
  f.send("node-paused", { instance: original });
  f.send("node-waiting", { instance: original, cause: "slot" }, 3_000);
  f.send("node-executing", { instance: original }, 3_100);
  assert.equal(f.node().phase, "paused");
  assert.equal(f.node().wait, undefined);
  f.send("node-settled", { instance: original, outcome: "cancelled" }, 4_000);
  f.send("node-waiting", { instance: original, cause: "backoff", attempt: 3, delayMs: 200 }, 5_000);
  assert.equal(f.node().phase, "settled");
  assert.equal(f.node().wait, undefined);
});

test("冷回放缺时间保持未知；重排队和缓存结算不继承实时活动", () => {
  const f = fixture();
  f.send("node-waiting", { instance: original, cause: "slot" });
  assert.deepEqual(f.node().wait, { cause: "slot" });
  f.send("node-activity", { instance: original, activity });
  f.send("node-queued", { instance: original, kind: "ask" });
  assert.equal(f.node().activity, undefined);
  assert.equal(f.node().wait, undefined);
  f.send("node-activity", { instance: original, activity });
  f.send("node-settled", { instance: original, outcome: "ok", cached: true });
  assert.equal(f.node().activity, undefined);
  assert.equal(f.node().settledAt, undefined);
});

test("活动严格有界，非法事件不抹除已知活动或创建假节点", () => {
  const f = fixture();
  const base = { siteId: "ask#1", ordinal: 1, phase: "executing" };
  assert.equal(workflowRunNodeSchema.safeParse(base).success, true);
  assert.deepEqual(workflowRunNodeSchema.parse({ ...base, activity }).activity, activity);
  for (const invalid of [
    { ...activity, observedAt: -1 },
    { ...activity, since: Number.NaN },
    { ...activity, requestsCompleted: 0.5 },
    { ...activity, toolCalls: -1 },
    { ...activity, requestId: "x".repeat(257) },
    { ...activity, toolName: "x".repeat(65) },
    { ...activity, kind: "deadlocked" },
    { ...activity, rawReasoning: "private" },
  ]) {
    assert.equal(workflowRunNodeSchema.safeParse({ ...base, activity: invalid }).success, false);
    f.send("node-activity", { instance: original, activity: invalid });
    assert.equal(f.node().activity, undefined);
  }
  f.send("node-activity", { instance: { siteId: "absent", ordinal: 1 }, activity });
  assert.equal(f.state().runs[0]!.nodes.length, 1);
});

test("旧 sequence 的活动重放不回退读面", () => {
  const f = fixture();
  f.send("node-activity", { instance: original, activity });
  const before = f.state();
  const next = reduceWorkflowRunsState(before, {
    runId: "run-one",
    sequence: 1,
    eventType: "node-activity",
    payload: { instance: original, activity: { ...activity, observedAt: 3_000 } },
  });
  assert.ok(next === null || next.runs[0]!.nodes[0]!.activity?.observedAt === 1_100);
  const waited = reduceWorkflowRunsState(before, {
    runId: "run-one",
    sequence: 1,
    eventType: "node-waiting",
    payload: { instance: original, cause: "backoff", attempt: 2 },
  });
  assert.ok(waited === null || waited.runs[0]!.nodes[0]!.wait === undefined);
  for (const eventType of [
    "node-queued",
    "node-dispatched",
    "node-paused",
    "node-retried",
    "node-settled",
    "run-started",
    "run-settled",
  ]) {
    const stale = reduceWorkflowRunsState(before, {
      runId: "run-one",
      sequence: 1,
      eventType,
      payload: { instance: original, kind: "ask", outcome: "ok", status: "completed" },
    });
    assert.equal(stale, null, `stale ${eventType}`);
  }
});
