import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundWorkSummary, WorkflowRunNode, WorkflowRunState } from "@lcode/shared/lcode-protocol-v4";
import { workflowProjectionDisplay } from "@/components/workflow-timeline/timeline-activity.js";
import { buildConversationStatusPanelModel, workflowRunOpenTarget } from "./conversationStatusPanelModel.js";

function node(actorOrdinal: number, patch: Partial<WorkflowRunNode> = {}): WorkflowRunNode {
  return {
    siteId: "ask#read",
    ordinal: actorOrdinal,
    actorSiteId: "actor#reader",
    actorOrdinal,
    phase: "executing",
    activity: { kind: "model", since: 1_000, observedAt: 2_000, requestsCompleted: 1, toolCalls: 0 },
    ...patch,
  };
}

function run(nodes: WorkflowRunNode[], patch: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-progress",
    toolCallId: "tool-progress",
    status: "running",
    actors: [1, 2, 3].map((ordinal) => ({ siteId: "actor#reader", ordinal, status: "running" })),
    nodes,
    usage: { spentTokens: 0, nodesUsed: nodes.length },
    lastEventSequence: 1,
    ...patch,
  };
}

function summary(current: WorkflowRunState, display = {}) {
  const model = buildConversationStatusPanelModel({ workflowRuns: [current], workflowDisplay: display });
  assert.equal(model.runningWorkflowRuns.length, 1);
  const value = model.runningWorkflowRuns[0]!.activitySummary;
  assert.ok(value);
  return value;
}

test("主会话摘要覆盖每个已观察 actor，而非任意一条最近活动", () => {
  const current = run([
    node(1),
    node(2, { phase: "waiting", wait: { cause: "backoff", attempt: 2, nextRetryAt: 6_000 } }),
    node(3, { phase: "queued", queue: { cause: "run-capacity", since: 1_000 }, activity: undefined }),
  ]);
  assert.deepEqual(summary(current), {
    groups: [{ kind: "model", count: 1 }, { kind: "backoff", count: 1 }, { kind: "run-capacity", count: 1 }],
    total: 3,
    truncated: false,
  });
  const withFollowup = { ...current, nodes: [...current.nodes, node(1, { siteId: "ask#followup", phase: "queued", queue: { cause: "actor-fifo" } })] };
  assert.deepEqual(summary(withFollowup), summary(current), "one actor's FIFO followup is not a fourth actor or a new current activity");
});

test("主会话同步与离线摘要从原父投影派生，不保留实时重试", () => {
  const current = run([node(1, { phase: "waiting", wait: { cause: "backoff", nextRetryAt: 6_000 } })]);
  for (const state of [
    { status: "connecting" as const },
    { status: "live" as const, syncing: true },
    { status: "error" as const },
    { status: "closed" as const },
  ]) {
    const value = summary(current, workflowProjectionDisplay(state));
    assert.deepEqual(value.groups, [{ kind: "unknown", count: 3 }]);
    assert.equal(value.connection, state.status === "error" || state.status === "closed" ? "stale" : "syncing");
  }
  assert.equal(summary(current, workflowProjectionDisplay({ status: "live" })).connection, undefined);
  assert.equal(summary(current).groups[0]!.kind, "backoff");
});

test("摘要保留问题、暂停、创建和截断语义，不虚构未来依赖", () => {
  const current = run([
    node(1),
    node(2, { phase: "paused" }),
  ], {
    truncated: true,
    pendingQuestions: [{ qid: "question", actorSiteId: "actor#reader", actorOrdinal: 1, question: "Confirm scope" }],
  });
  assert.deepEqual(summary(current), {
    groups: [{ kind: "question", count: 1 }, { kind: "paused", count: 1 }, { kind: "created", count: 1 }],
    total: 3,
    truncated: true,
  });
  assert.deepEqual(summary(run([], { actors: [] })), { groups: [], total: 0, truncated: false });
});

test("添加摘要不改变停止句柄、详情目标、结束过滤与旧 CLI 降级", () => {
  const current = run([node(1)]);
  const work: BackgroundWorkSummary = {
    workId: current.runId,
    kind: "workflow",
    status: "running",
    title: "Execution progress",
    startedAt: 0,
    cancellable: true,
    anchorRowId: null,
  };
  const model = buildConversationStatusPanelModel({
    workflowRuns: [current, { ...current, runId: "ended", status: "completed" }],
    backgroundWorks: [work],
  });
  assert.equal(model.runningWorkflowRuns.length, 1);
  assert.equal(model.runningBashWorks.length, 0);
  assert.equal(model.runningWorkflowRuns[0]!.workId, current.runId);
  assert.equal(model.runningWorkflowRuns[0]!.cancellable, true);
  assert.deepEqual(workflowRunOpenTarget(model.runningWorkflowRuns[0]!), {
    runId: current.runId,
    toolCallId: current.toolCallId,
    workflowName: work.title,
  });
  const legacy = buildConversationStatusPanelModel({ backgroundWorks: [work] }).runningWorkflowRuns[0]!;
  assert.equal(legacy.activitySummary, undefined);
  assert.equal(legacy.workId, work.workId);
  assert.equal(legacy.cancellable, true);
  assert.equal(workflowRunOpenTarget(legacy), null);
});
