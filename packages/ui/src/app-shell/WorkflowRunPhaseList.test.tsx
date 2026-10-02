import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowRunState } from "@lcode/shared/lcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline, type WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkflowRunPhaseList } from "./WorkflowRunPhaseList.js";

test("run details mark partial stage counts only when the projection is truncated", () => {
  const graph: WorkflowCausalityGraphData = {
    steps: [],
    lanes: [],
    participants: [],
    handoffs: [],
  };
  const model: WorkflowTimelineModel = {
    stations: [],
    rails: [],
    arcs: [],
    bands: [],
    live: true,
    runningIndex: undefined,
  };
  const run: WorkflowRunState = {
    runId: "large",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 1,
    truncated: true,
  };
  const render = (current: WorkflowRunState) =>
    renderToStaticMarkup(
      <LCodeIntlProvider initialLocale="zh-CN">
        <WorkflowRunPhaseList graph={graph} model={model} run={current} pendingQuestions={[]} />
      </LCodeIntlProvider>,
    );
  assert.match(render(run), /data-testid="workflow-run-partial-status"/);
  assert.match(render(run), /阶段计数可能不完整/);
  assert.doesNotMatch(render({ ...run, truncated: undefined }), /workflow-run-partial-status/);
});

test("phase rows use the shared activity details and attach questions only to their active phase", () => {
  const graph: WorkflowCausalityGraphData = {
    lanes: [{ id: "actor#1", name: "Reader" }],
    steps: [
      { id: "ask#1~A", source: "ask#1", kind: "ask", label: "Read", lane: "actor#1", phase: "A" },
      { id: "ask#1~B", source: "ask#1", kind: "ask", label: "Review", lane: "actor#1", phase: "B" },
    ],
    phases: [{ id: "A", name: "Read" }, { id: "B", name: "Review" }],
    participants: [
      { id: "reader-A", phase: "A", lane: "actor#1", steps: ["ask#1~A"] },
      { id: "reader-B", phase: "B", lane: "actor#1", steps: ["ask#1~B"] },
    ],
    handoffs: [],
  };
  const run: WorkflowRunState = {
    runId: "progress", status: "running", usage: { spentTokens: 0, nodesUsed: 1 },
    actors: [{ siteId: "actor#1", ordinal: 1, status: "running", phaseName: "Read" }],
    nodes: [{ siteId: "ask#1", ordinal: 1, actorSiteId: "actor#1", actorOrdinal: 1, phaseName: "Read", phase: "executing", activity: {
      kind: "model", observedAt: 100, since: 90, requestsCompleted: 1, toolCalls: 2,
    } }],
    pendingQuestions: [{ qid: "question", actorSiteId: "actor#1", actorOrdinal: 1, question: "Need the filename" }],
    currentPhase: "Read", lastEventSequence: 1,
  };
  const model = buildWorkflowTimeline(graph, run);
  const html = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <WorkflowRunPhaseList graph={graph} model={model} run={run} pendingQuestions={run.pendingQuestions!} onOpenActor={() => {}} />
    </LCodeIntlProvider>,
  );
  assert.match(html, /等待主代理答复/);
  assert.match(html, /workflow-activity-open/);
  assert.match(html, /workflow-run-agent-open/);
  assert.equal((html.match(/data-testid="workflow-run-question"/g) ?? []).length, 1);
  assert.equal(model.stations[1]!.pills[0]!.activity?.kind, "not-started");
  assert.equal(model.stations[1]!.pills[0]!.asking, undefined);
  const syncing = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="en-US">
      <WorkflowRunPhaseList graph={graph} model={buildWorkflowTimeline(graph, run, { syncing: true })} run={run} pendingQuestions={run.pendingQuestions!} />
    </LCodeIntlProvider>,
  );
  assert.match(syncing, /Syncing; showing the last known state/);
  assert.doesNotMatch(syncing, /Streaming reasoning|Expected to continue/);
});
