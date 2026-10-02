import assert from "node:assert/strict";
import test from "node:test";
import type { ActorRecord, NodeRecord, StoredEvent } from "@lcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@lcode/shared/lcode-protocol-v4";
import { indexRosterEvents } from "./dynamic-workflow-run-roster-events.js";
import { buildSubagentViews } from "./dynamic-workflow-run-roster-subagents.js";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";

const actor = {
  runId: "run-one",
  siteId: "actor#one",
  ordinal: 1,
  name: "服务调查",
  persona: {},
  sessionId: "child-one",
} as ActorRecord;
const node: NodeRecord = {
  runId: "run-one",
  siteId: "ask#one",
  ordinal: 1,
  kind: "ask",
  actorSiteId: actor.siteId,
  actorOrdinal: 1,
  actorSeq: 0,
  inputHash: "hash",
  status: "running",
};
const instance = { siteId: node.siteId, ordinal: 1 };
const activity = {
  kind: "tool" as const,
  observedAt: 1_100,
  since: 1_100,
  requestsCompleted: 3,
  toolCalls: 4,
  toolName: "Read",
  lastRequestCompletedAt: 1_050,
};

function views(events: StoredEvent[], nodes = [node], now = 8_000) {
  let state: WorkflowRunsState | undefined;
  for (const event of events) {
    state =
      reduceWorkflowRunsState(
        state,
        toProgressPayload({ runId: "run-one", ...event, occurredAt: event.timeCreated }),
      ) ?? state;
  }
  return buildSubagentViews({
    actors: [actor],
    nodes,
    run: state?.runs[0],
    index: indexRosterEvents(events, now),
    terminal: false,
  });
}

const started: StoredEvent[] = [
  {
    sequence: 1,
    timeCreated: 1_000,
    event: {
      type: "node-queued",
      instance,
      kind: "ask",
      actor: { siteId: actor.siteId, ordinal: 1 },
    },
  },
  { sequence: 2, timeCreated: 1_010, event: { type: "node-dispatched", instance } },
];

test("只读 roster 复用同一活动摘要，不把工具进展当交付", () => {
  const result = views([
    ...started,
    { sequence: 3, timeCreated: 1_200, event: { type: "node-activity", instance, activity } },
  ])[0]!;
  assert.deepEqual(result.currentAsk?.activity, activity);
  assert.equal(result.currentAsk?.turn, undefined);
  assert.equal(result.stepsSettled, 0);
  assert.equal(result.lastProgressAt, 1_010);
});

test("同 actor 的后续排队 ask 不遮住当前实际执行的活动", () => {
  const future: NodeRecord = { ...node, siteId: "ask#future", actorSeq: 1 };
  const result = views(
    [
      ...started,
      { sequence: 3, timeCreated: 1_100, event: { type: "node-executing", instance } },
      { sequence: 4, timeCreated: 1_200, event: { type: "node-activity", instance, activity } },
      {
        sequence: 5,
        timeCreated: 1_300,
        event: {
          type: "node-queued",
          instance: { siteId: future.siteId, ordinal: 1 },
          kind: "ask",
          actor: { siteId: actor.siteId, ordinal: 1 },
        },
      },
    ],
    [node, future],
  )[0]!;
  assert.equal(result.currentAsk?.siteId, node.siteId);
  assert.deepEqual(result.currentAsk?.activity, activity);
});

test("排队、已派发未确认执行和暂停都不由 journal running 推断 executing", () => {
  const queued = views([started[0]!])[0]!;
  assert.equal(queued.state, "waiting");
  assert.equal(queued.currentAsk?.phase, "queued");
  const dispatched = views(started)[0]!;
  assert.equal(dispatched.state, "waiting");
  assert.equal(dispatched.currentAsk?.phase, "dispatched");
  const paused = views([
    ...started,
    { sequence: 3, timeCreated: 1_100, event: { type: "node-paused", instance } },
  ])[0]!;
  assert.equal(paused.state, "waiting");
  assert.equal(paused.currentAsk?.phase, "paused");
  const unknown = views([])[0]!;
  assert.equal(unknown.state, "waiting");
  assert.equal(unknown.currentAsk?.phase, undefined);
});

test("名册保留队列来源与同 actor 下一次 ask 之前的成功交付", () => {
  const future: NodeRecord = { ...node, siteId: "ask#next", actorSeq: 1 };
  const futureRef = { siteId: future.siteId, ordinal: 1 };
  const result = views(
    [
      ...started,
      { sequence: 3, timeCreated: 1_200, event: { type: "node-settled", instance, outcome: "ok" } },
      {
        sequence: 4,
        timeCreated: 1_300,
        event: {
          type: "node-queued",
          instance: futureRef,
          kind: "ask",
          actor: { siteId: actor.siteId, ordinal: 1 },
        },
      },
      {
        sequence: 5,
        timeCreated: 1_400,
        event: { type: "node-admission", instance: futureRef, cause: "run-capacity" },
      },
    ],
    [{ ...node, status: "completed" }, future],
  )[0]!;
  assert.equal(result.state, "waiting");
  assert.equal(result.currentAsk?.siteId, future.siteId);
  assert.deepEqual(result.currentAsk?.queue, { cause: "run-capacity", since: 1_400 });
  assert.equal(result.lastDeliveredAt, 1_200);
});

test("失败与缓存结算不冒充交付，旧结算重放不能回退最近交付", () => {
  for (const final of [{ outcome: "failed" as const }, { outcome: "ok" as const, cached: true }]) {
    const result = views([
      ...started,
      { sequence: 3, timeCreated: 2_000, event: { type: "node-settled", instance, ...final } },
    ])[0]!;
    assert.equal(result.lastDeliveredAt, undefined);
  }
  const entries: StoredEvent[] = [
    ...started,
    { sequence: 3, timeCreated: 2_000, event: { type: "node-settled", instance, outcome: "ok" } },
    { sequence: 2, timeCreated: 5_000, event: { type: "node-settled", instance, outcome: "ok" } },
  ];
  assert.equal(views(entries)[0]?.lastDeliveredAt, 2_000);
  assert.equal(views(entries, [node], 1_000)[0]?.lastDeliveredAt, 2_000);
});

test("暂停和重试清除旧供应商等待，旧 attempt 不覆盖新队列", () => {
  const current = { ...instance, attempt: 2 };
  const result = views([
    ...started,
    {
      sequence: 3,
      timeCreated: 1_100,
      event: { type: "node-waiting", instance, cause: "backoff", attempt: 2, delayMs: 500 },
    },
    { sequence: 4, timeCreated: 1_200, event: { type: "node-paused", instance } },
    { sequence: 5, timeCreated: 1_300, event: { type: "node-retried", instance: current } },
    {
      sequence: 6,
      timeCreated: 1_400,
      event: { type: "node-admission", instance: current, cause: "run-capacity" },
    },
    { sequence: 7, timeCreated: 1_500, event: { type: "node-waiting", instance, cause: "slot" } },
  ])[0]!;
  assert.equal(result.state, "waiting");
  assert.equal(result.wait, undefined);
  assert.equal(result.currentAsk?.phase, "queued");
  assert.equal(result.currentAsk?.queue?.cause, "run-capacity");
});

test("只读等待保留第一次等待及最新重试目标时间", () => {
  const result = views([
    ...started,
    {
      sequence: 3,
      timeCreated: 2_000,
      event: {
        type: "node-waiting",
        instance,
        cause: "backoff",
        reason: "network_error",
        attempt: 2,
        delayMs: 500,
      },
    },
    {
      sequence: 4,
      timeCreated: 3_000,
      event: {
        type: "node-waiting",
        instance,
        cause: "backoff",
        reason: "timeout",
        attempt: 3,
        delayMs: 2_000,
      },
    },
  ])[0]!;
  assert.deepEqual(result.wait, {
    cause: "backoff",
    reason: "timeout",
    attempt: 3,
    since: 2_000,
    nextRetryAt: 5_000,
  });
});
