import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
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
      <ZCodeIntlProvider initialLocale="zh-CN">
        <WorkflowRunPhaseList graph={graph} model={model} run={current} pendingQuestions={[]} />
      </ZCodeIntlProvider>,
    );
  assert.match(render(run), /data-testid="workflow-run-partial-status"/);
  assert.match(render(run), /阶段计数可能不完整/);
  assert.doesNotMatch(render({ ...run, truncated: undefined }), /workflow-run-partial-status/);
});
