import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkflowRunToolResultDisplayPayloadSchema,
  GetWorkflowRunOutputSchema,
  type DynamicWorkflowRunSubagentView,
} from "@lcode/contracts";
import { toolCallGetWorkflowRunDisplaySchema } from "@lcode/shared/lcode-protocol-v4";
import { toGetWorkflowRunSubagents } from "../handlers/get-workflow-run-roster-output.js";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";
import { formatWorkflowRunSubagentsBlock } from "../handlers/get-workflow-run-format-roster.js";
import { buildWorkflowRunSummary } from "../handlers/get-workflow-run-summary.js";

const activity = {
  kind: "model" as const,
  observedAt: 2_000,
  since: 2_000,
  requestsCompleted: 2,
  toolCalls: 4,
};
const subagent: DynamicWorkflowRunSubagentView = {
  siteId: "actor#one",
  ordinal: 1,
  state: "waiting",
  stepsSettled: 0,
  stepsFailed: 0,
  tokens: 0,
  currentAsk: { siteId: "ask#one", ordinal: 1, phase: "waiting", activity },
  lastDeliveredAt: 1_500,
  wait: { cause: "backoff", reason: "network_error", attempt: 2, since: 2_500, nextRetryAt: 4_500 },
};

function output() {
  return {
    runId: "run-one",
    label: "任务",
    labelSource: "name",
    status: "running",
    ownedByThisSession: true,
    createdAt: 1_000,
    updatedAt: 2_500,
    summary: "运行中",
    generatedAt: 3_000,
    usage: { spentTokens: 0, nodesObserved: 1, nodesRunning: 1, nodesCompleted: 0, nodesFailed: 0 },
    actors: [{ siteId: "actor#one", ordinal: 1 }],
    logTail: [],
    subagents: toGetWorkflowRunSubagents([subagent]).subagents,
    health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
  };
}

test("GetWorkflowRun 活动经过输出和 display 保持双方 strict 契约一致", () => {
  const result = output();
  assert.deepEqual(result.subagents[0]?.currentAsk?.activity, activity);
  assert.deepEqual(result.subagents[0]?.wait, subagent.wait);
  const display = createWorkflowObservationDisplay("GetWorkflowRun", result);
  assert.ok(display?.kind === "get_workflow_run");
  const row = display.subagents?.[0];
  assert.deepEqual(row?.activity, activity);
  assert.equal(row?.askPhase, "waiting");
  assert.equal(row?.lastDeliveredAt, 1_500);
  assert.equal(row?.retryAttempt, 2);
  assert.equal(row?.nextRetryAt, 4_500);
  assert.equal(row?.waitReason, "network_error");
  assert.deepEqual(
    getWorkflowRunToolResultDisplayPayloadSchema.parse(display),
    toolCallGetWorkflowRunDisplaySchema.parse(display),
  );
});

test("入队来源与前次交付跨越 CLI/shared 严格输出边界且保留旧数据兼容", () => {
  const result = output();
  const queue = {
    cause: "actor-fifo" as const,
    since: 1_000,
    blockedBy: { siteId: "ask#prior", ordinal: 1, attempt: 2 },
  };
  result.subagents = toGetWorkflowRunSubagents([
    {
      ...subagent,
      currentAsk: { siteId: "ask#one", ordinal: 1, phase: "queued", queue },
      wait: undefined,
    },
  ]).subagents;
  const display = createWorkflowObservationDisplay("GetWorkflowRun", result);
  assert.ok(display?.kind === "get_workflow_run");
  assert.equal(display.subagents?.[0]?.askPhase, "queued");
  assert.deepEqual(display.subagents?.[0]?.queue, queue);
  assert.equal(display.subagents?.[0]?.waitCause, undefined);
  assert.equal(display.subagents?.[0]?.lastDeliveredAt, 1_500);
  assert.deepEqual(
    getWorkflowRunToolResultDisplayPayloadSchema.parse(display),
    toolCallGetWorkflowRunDisplaySchema.parse(display),
  );
  for (const invalid of [
    { askPhase: "running" },
    { lastDeliveredAt: -1 },
    { queue: { cause: "provider" } },
    { queue: { ...queue, blockedBy: { siteId: "x".repeat(65), ordinal: 1 } } },
    { queue: { ...queue, secret: "raw" } },
  ]) {
    const candidate = { ...display, subagents: [{ ...display.subagents?.[0], ...invalid }] };
    assert.equal(getWorkflowRunToolResultDisplayPayloadSchema.safeParse(candidate).success, false);
    assert.equal(toolCallGetWorkflowRunDisplaySchema.safeParse(candidate).success, false);
  }
});

test("模型观察文本等待时保留统计和成功交付，但不误称排队请求正在执行", () => {
  const result = output();
  const parsed = GetWorkflowRunOutputSchema.parse(result);
  const content = formatWorkflowRunSubagentsBlock(parsed);
  const summary = buildWorkflowRunSummary(parsed);
  assert.match(summary, /1 unsettled/);
  assert.match(summary, /agents: 1 waiting/);
  assert.doesNotMatch(summary, /1 running|dispatched steps/);
  assert.match(content, /backoff/);
  assert.match(content, /2 successful requests/);
  assert.match(content, /4 tool calls/);
  assert.match(content, /last observed delivery/);
  assert.doesNotMatch(content, /model request in progress/);
  for (const phase of ["queued", "dispatched", "paused"] as const) {
    result.subagents = toGetWorkflowRunSubagents([
      {
        ...subagent,
        currentAsk: { ...subagent.currentAsk!, phase },
        wait: undefined,
      },
    ]).subagents;
    const text = formatWorkflowRunSubagentsBlock(GetWorkflowRunOutputSchema.parse(result));
    assert.doesNotMatch(text, /model request in progress/);
    assert.match(
      text,
      phase === "queued"
        ? /queued; admission reason unknown/
        : phase === "paused"
          ? /task paused/
          : /model execution not yet observed/,
    );
  }
});

test("旧观察卡不需要活动字段，新增活动不允许原始推理正文或非法计数", () => {
  const result = output();
  result.subagents = toGetWorkflowRunSubagents([
    { ...subagent, currentAsk: undefined, wait: undefined },
  ]).subagents;
  const display = createWorkflowObservationDisplay("GetWorkflowRun", result);
  assert.ok(display?.kind === "get_workflow_run");
  assert.equal(toolCallGetWorkflowRunDisplaySchema.safeParse(display).success, true);
  for (const invalid of [
    { ...activity, rawReasoning: "secret" },
    { ...activity, requestsCompleted: -1 },
  ]) {
    const withActivity = {
      ...display,
      subagents: [{ ...display.subagents?.[0], activity: invalid }],
    };
    assert.equal(
      getWorkflowRunToolResultDisplayPayloadSchema.safeParse(withActivity).success,
      false,
    );
    assert.equal(toolCallGetWorkflowRunDisplaySchema.safeParse(withActivity).success, false);
  }
});
