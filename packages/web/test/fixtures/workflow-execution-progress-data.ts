import type { LCodePermissionRequest } from "@lcode/shared";
import {
  workflowScriptFingerprint,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "@lcode/shared/lcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

export const scenarios = [
  "model",
  "reasoning",
  "text",
  "tool",
  "slot",
  "backoff",
  "recovered",
  "unstarted",
  "created",
  "queued",
  "actor-fifo",
  "run-capacity",
  "dispatched",
  "concurrent-retry",
  "next-ask",
  "next-phase",
  "truncated",
  "mixed",
  "paused",
  "completed",
  "failed",
  "stopped",
  "cached",
  "legacy",
  "question",
  "dense",
] as const;
export type ProgressScenario = (typeof scenarios)[number];
export const graph: WorkflowCausalityGraphData = {
  lanes: [{ id: "actor#1", name: "Reader" }],
  steps: [
    {
      id: "ask#1~A",
      source: "ask#1",
      kind: "ask",
      label: "Read sources",
      lane: "actor#1",
      phase: "A",
    },
    {
      id: "ask#1~B",
      source: "ask#1",
      kind: "ask",
      label: "Review delivery",
      lane: "actor#1",
      phase: "B",
    },
  ],
  participants: [
    { id: "reader-A", phase: "A", lane: "actor#1", steps: ["ask#1~A"] },
    { id: "reader-B", phase: "B", lane: "actor#1", steps: ["ask#1~B"] },
  ],
  phases: [
    { id: "A", name: "Read" },
    { id: "B", name: "Review" },
  ],
  phaseEdges: [{ from: "A", to: "B" }],
  handoffs: [],
};

export function progressRun(scenario: ProgressScenario, now: number): WorkflowRunState {
  const activity = {
    kind:
      scenario === "reasoning" || scenario === "text" || scenario === "tool"
        ? scenario
        : ("model" as const),
    observedAt: now - 2_000,
    since: now - 5_000,
    requestsCompleted: 2,
    toolCalls: 3,
    lastRequestCompletedAt: now - 8_000,
    ...(scenario === "tool" ? { toolName: "Read" } : {}),
  };
  const node: WorkflowRunNode = {
    siteId: "ask#1",
    ordinal: 1,
    actorSiteId: "actor#1",
    actorOrdinal: 1,
    phaseName: "Read",
    phase: "executing",
    activity,
  };
  if (scenario === "slot" || scenario === "backoff") {
    node.phase = "waiting";
    node.wait =
      scenario === "slot"
        ? { cause: "slot", since: now - 3_000 }
        : {
            cause: "backoff",
            reason: "stream_idle_timeout",
            attempt: 2,
            since: now - 3_000,
            nextRetryAt: now + 20_000,
          };
  }
  if (scenario === "concurrent-retry") {
    node.phase = "waiting";
    node.wait = { cause: "backoff", reason: "network_error", attempt: 2, since: now - 3_000, nextRetryAt: now + 20_000 };
    node.activity = { ...activity, kind: "tool", toolName: "Read" };
  }
  if (scenario === "queued" || scenario === "actor-fifo" || scenario === "run-capacity" || scenario === "dispatched") {
    node.phase = scenario === "dispatched" ? "dispatched" : "queued";
    if (scenario === "actor-fifo" || scenario === "run-capacity")
      node.queue = { cause: scenario, since: now - 3_000 };
    delete node.activity;
  }
  if (scenario === "paused") {
    node.phase = "paused";
    node.wait = { cause: "backoff", attempt: 2, nextRetryAt: now + 20_000 };
  }
  if (scenario === "legacy") delete node.activity;
  if (["completed", "failed", "stopped", "cached"].includes(scenario)) {
    node.phase = "settled";
    node.outcome = scenario === "failed" ? "failed" : scenario === "stopped" ? "cancelled" : "ok";
    node.settledAt = now - 1_000;
    if (scenario === "cached") node.cached = true;
  }
  const run: WorkflowRunState = {
    runId: "fixture-progress",
    toolCallId: "fixture-create",
    status:
      scenario === "completed" || scenario === "cached"
        ? "completed"
        : scenario === "failed"
          ? "errored"
          : scenario === "stopped"
            ? "stopped"
            : "running",
    actors:
      scenario === "unstarted"
        ? []
        : [
            {
              siteId: "actor#1",
              ordinal: 1,
              name: "Reader",
              status: "running",
              phaseName: "Read",
              sessionId: "fixture-child",
            },
          ],
    nodes: scenario === "unstarted" || scenario === "created" ? [] : [node],
    currentPhase: "Read",
    phases: [{ name: "Read", rounds: 1 }],
    usage: { spentTokens: 120, nodesUsed: 1 },
    lastEventSequence: 1,
    ...(scenario === "question"
      ? {
          pendingQuestions: [
            {
              qid: "fixture-question",
              actorSiteId: "actor#1",
              actorOrdinal: 1,
              actorName: "Reader",
              question: "Which file should be reviewed?",
              askedAt: now - 10_000,
            },
          ],
        }
      : {}),
  };
  if (scenario === "dense") {
    run.actors = Array.from({ length: 12 }, (_, index) => ({
      siteId: "actor#1",
      ordinal: index + 1,
      name: `Reader ${index + 1}`,
      status: "running",
      phaseName: "Read",
    }));
    run.nodes = run.actors.map((actor) => ({
      ...node,
      ordinal: actor.ordinal,
      actorOrdinal: actor.ordinal,
      phase: actor.ordinal === 8 ? "waiting" : "executing",
      ...(actor.ordinal === 8
        ? {
            wait: {
              cause: "backoff" as const,
              reason: "network_error",
              attempt: 2,
              nextRetryAt: now + 20_000,
            },
          }
        : {}),
    }));
  }
  if (scenario === "next-ask" || scenario === "next-phase" || scenario === "truncated") {
    const next = {
      ...node,
      ordinal: 2,
      phaseName: scenario === "next-phase" ? "Review" : "Read",
      activity: { ...activity, requestsCompleted: 0, toolCalls: 0, lastRequestCompletedAt: undefined },
    };
    run.nodes = [
      { ...node, phase: "settled", outcome: "ok", settledAt: now - 10_000 },
      next,
    ];
    run.currentPhase = next.phaseName;
    if (scenario === "truncated") run.truncated = true;
  }
  if (scenario === "mixed") {
    run.actors = [1, 2, 3, 4].map((ordinal) => ({
      siteId: "actor#1", ordinal, name: `Reader ${ordinal}`, status: "running", phaseName: "Read",
    }));
    run.nodes = run.actors.map((actor) => ({
      ...node,
      ordinal: actor.ordinal,
      actorOrdinal: actor.ordinal,
      ...(actor.ordinal === 3 ? { phase: "waiting", wait: { cause: "backoff", attempt: 2, since: now - 3_000, nextRetryAt: now + 20_000 } } : {}),
      ...(actor.ordinal === 4 ? { phase: "queued", queue: { cause: "run-capacity", since: now - 3_000 }, activity: undefined } : {}),
    }));
  }
  return run;
}

const script =
  'phase("Read");\nconst result = await agent("Reader").ask("Read sources");\nphase("Review");\nawait agent("Reviewer").ask("Review sources");\nreturn result;';
export function progressPermission(adviceMode: "valid" | "stale" | "none"): LCodePermissionRequest {
  return {
    type: "permission_request",
    requestId: "fixture-permission",
    taskId: "fixture-parent",
    traceId: "fixture-trace",
    kind: "CreateWorkflow",
    description: "Fixture only; never runs a workflow",
    options: [],
    raw: {
      name: "Execution progress",
      script: adviceMode === "stale" ? `${script}\n// changed` : script,
      ...(adviceMode === "none"
        ? {}
        : {
            orchestration_advice: {
              scriptHash: workflowScriptFingerprint(script),
              items: [
                {
                  code: "await-before-later-asks",
                  line: 2,
                  column: 16,
                  waitingOn: [{ line: 2, column: 22 }],
                  delayed: [{ line: 4, column: 1 }],
                  message: "Do not display raw advice messages",
                },
              ],
            },
          }),
    },
    display: {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: graph,
    },
  };
}
