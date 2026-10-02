import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunNode, WorkflowRunState } from "@lcode/shared/lcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline, pillActivity } from "./timeline-model.js";
import { workflowActivityNeedsClock, workflowPillActivity } from "./timeline-activity.js";

test("等待和工具时长由父视图秒针更新，静默不冻结且恢复/终态不继续计时", () => {
  for (const kind of ["slot", "backoff", "actor-fifo", "run-capacity", "tool"] as const) {
    assert.equal(workflowActivityNeedsClock({ kind, since: 1_000 }), true);
    assert.equal(workflowActivityNeedsClock({ kind, since: 1_000, connection: "syncing" }), false);
    assert.equal(workflowActivityNeedsClock({ kind, since: 1_000, connection: "stale" }), false);
  }
  assert.equal(workflowActivityNeedsClock({ kind: "backoff", nextRetryAt: 2_000 }), true);
  assert.equal(workflowActivityNeedsClock({ kind: "paused", since: 1_000 }), false);
  assert.equal(workflowActivityNeedsClock({ kind: "ended", since: 1_000 }), false);
  assert.equal(workflowActivityNeedsClock({ kind: "model" }), false);
});

const graph: WorkflowCausalityGraphData = {
  lanes: [{ id: "actor#1", name: "Reader" }],
  steps: [
    { id: "ask#1~A", source: "ask#1", kind: "ask", label: "Read", lane: "actor#1", phase: "A" },
    { id: "ask#1~B", source: "ask#1", kind: "ask", label: "Review", lane: "actor#1", phase: "B" },
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

const observed = {
  kind: "model" as const,
  observedAt: 1_200,
  since: 1_000,
  requestsCompleted: 2,
  toolCalls: 3,
  lastRequestCompletedAt: 900,
};

function node(patch: Partial<WorkflowRunNode> = {}): WorkflowRunNode {
  return {
    siteId: "ask#1",
    ordinal: 1,
    actorSiteId: "actor#1",
    actorOrdinal: 1,
    phase: "executing",
    phaseName: "Read",
    activity: observed,
    ...patch,
  };
}

function run(nodes: WorkflowRunNode[], patch: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "progress",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: nodes.length },
    actors: [
      { siteId: "actor#1", ordinal: 1, name: "Reader", status: "running", phaseName: "Read" },
    ],
    nodes,
    currentPhase: "Read",
    lastEventSequence: 1,
    ...patch,
  };
}

function activity(
  current: WorkflowRunState,
  connection?: Parameters<typeof buildWorkflowTimeline>[2],
) {
  const model = buildWorkflowTimeline(graph, current, connection);
  const pill = model.stations[0]!.pills[0]!;
  const selected = pillActivity(graph, current, pill).activity;
  assert.ok(selected);
  assert.deepEqual(selected, pill.activity, "card and details share one pure activity view");
  return selected;
}

test("unstarted and created asks are not described as waiting for a slot", () => {
  assert.equal(activity(run([], { actors: [] })).kind, "not-started");
  assert.equal(activity(run([])).kind, "created");
  assert.equal(activity(run([node({ phase: "queued", activity: undefined })])).kind, "queued");
  assert.equal(
    activity(run([node({ phase: "dispatched", activity: undefined })])).kind,
    "dispatched",
  );
  const model = buildWorkflowTimeline(graph, undefined);
  assert.equal(model.stations[0]!.pills[0]!.activity, undefined);
});

test("model requests without deltas do not claim hidden reasoning; real deltas distinguish output", () => {
  assert.equal(activity(run([node()])).kind, "model");
  for (const kind of ["text", "reasoning", "tool", "unknown"] as const) {
    const value = activity(run([node({ activity: { ...observed, kind, toolName: "Read" } })]));
    assert.equal(value.kind, kind);
    assert.equal(value.observedAt, 1_200);
    assert.equal(value.requestsCompleted, 2);
    assert.equal(value.toolCalls, 3);
    assert.equal(value.lastRequestCompletedAt, 900);
    assert.equal(value.toolName, kind === "tool" ? "Read" : undefined);
  }
});

test("only authoritative waits show slot or first retry metadata and recovery clears them", () => {
  const slot = activity(run([node({ phase: "waiting", wait: { cause: "slot", since: 1_300 } })]));
  assert.equal(slot.kind, "slot");
  const retry = activity(
    run([
      node({
        phase: "waiting",
        wait: {
          cause: "backoff",
          attempt: 2,
          reason: "stream_idle_timeout",
          since: 1_300,
          nextRetryAt: 6_300,
        },
      }),
    ]),
  );
  assert.equal(retry.kind, "backoff");
  assert.equal(retry.retryNumber, 1, "attempt 2 is the first retry, not retry 2");
  assert.equal(retry.reason, "stream_idle_timeout");
  assert.equal(retry.nextRetryAt, 6_300);
  const recovered = activity(
    run([node({ wait: { cause: "backoff", attempt: 2, nextRetryAt: 6_300 } })]),
  );
  assert.equal(recovered.kind, "model");
  assert.equal(recovered.nextRetryAt, undefined);
  assert.equal(recovered.reason, undefined);
});

test("provider waits retain an independently observed in-flight tool without changing the wait", () => {
  for (const cause of ["slot", "backoff"] as const) {
    const current = run([
      node({
        phase: "waiting",
        wait: { cause, attempt: 2, reason: "network_error", nextRetryAt: 6_300 },
        activity: { ...observed, kind: "tool", toolName: "Read" },
      }),
    ]);
    const value = activity(current);
    assert.equal(value.kind, cause);
    assert.equal(value.toolName, "Read");
    assert.equal(value.nextRetryAt, cause === "backoff" ? 6_300 : undefined);
    assert.equal(activity(current, { syncing: true }).toolName, undefined);
    assert.equal(activity({ ...current, status: "stopped" }).toolName, undefined);
  }
});

test("site, actor ordinal and phase binding prevent old asks from lighting future stages", () => {
  const current = run(
    [
      node(),
      node({
        ordinal: 2,
        actorOrdinal: 2,
        activity: { ...observed, kind: "reasoning", observedAt: 9_000 },
      }),
      node({ siteId: "ask#other", activity: { ...observed, kind: "tool", toolName: "Bash" } }),
    ],
    {
      pendingQuestions: [
        { qid: "q", actorSiteId: "actor#1", actorOrdinal: 1, question: "Which file?" },
      ],
    },
  );
  const model = buildWorkflowTimeline(graph, current);
  assert.equal(model.stations[0]!.pills[0]!.activity?.kind, "question");
  assert.equal(model.stations[0]!.pills[0]!.activity?.observedAt, 1_200);
  assert.equal(model.stations[1]!.pills[0]!.activity?.kind, "not-started");
  assert.equal(model.stations[1]!.pills[0]!.activity?.observedAt, undefined);
  assert.equal(model.stations[1]!.pills[0]!.asking, undefined);
});

test("paused, terminal and recovering snapshots retain history, not current output or retry countdowns", () => {
  const staleWait = { cause: "backoff" as const, attempt: 2, nextRetryAt: 6_300 };
  assert.equal(activity(run([node({ phase: "paused", wait: staleWait })])).kind, "paused");
  for (const status of ["completed", "stopped", "errored"] as const) {
    const value = activity(run([node({ wait: staleWait })], { status }));
    assert.equal(value.kind, "ended");
    assert.equal(value.nextRetryAt, undefined);
    assert.equal(value.requestsCompleted, 2);
  }
  for (const display of [{ syncing: true }, { stale: true }]) {
    const value = activity(run([node({ phase: "waiting", wait: staleWait })]), display);
    assert.equal(value.kind, "unknown");
    assert.equal(value.nextRetryAt, undefined);
    assert.equal(value.observedAt, 1_200, "recovery must not replace the source clock");
    assert.ok(value.connection);
  }
});

test("old snapshots preserve unknown counts and only accepted non-cached results are delivery", () => {
  const old = activity(run([node({ activity: undefined })]));
  assert.equal(old.kind, "unknown");
  assert.equal(old.requestsCompleted, undefined);
  assert.equal(old.toolCalls, undefined);
  assert.equal(old.observedAt, undefined);
  assert.equal(activity(run([node({ activity: undefined, toolCalls: 4 })])).toolCalls, 4);
  const accepted = node({ phase: "settled", outcome: "ok", settledAt: 2_000 });
  assert.equal(activity(run([accepted])).deliveredAt, 2_000);
  for (const patch of [
    { cached: true },
    { outcome: "failed" as const },
    { outcome: "cancelled" as const },
  ]) {
    assert.equal(activity(run([{ ...accepted, ...patch }])).deliveredAt, undefined);
  }
});

test("same-actor queued follow-up does not replace the active ask's activity", () => {
  const current = run([node(), node({ ordinal: 2, phase: "queued", activity: undefined })]);
  assert.equal(activity(current).kind, "model");
  assert.equal(activity(current).requestsCompleted, 2);
});

test("queue causes require scheduler evidence and keep the earliest same-actor ask", () => {
  for (const cause of ["actor-fifo", "run-capacity"] as const) {
    const queue = { cause, since: 1_300, blockedBy: { siteId: "ask#previous", ordinal: 1 } };
    const value = activity(run([node({ phase: "queued", queue, activity: undefined })]));
    assert.equal(value.kind, cause);
    assert.equal(value.since, 1_300);
    assert.equal(value.observedAt, undefined);
    assert.equal(value.nextRetryAt, undefined);
  }
  const queued = run([
    node({ phase: "queued", queue: { cause: "run-capacity", since: 1_000 }, activity: undefined }),
    node({
      ordinal: 2,
      phase: "queued",
      queue: { cause: "actor-fifo", since: 2_000 },
      activity: undefined,
    }),
  ]);
  assert.equal(activity(queued).kind, "run-capacity");
  assert.equal(activity(queued).since, 1_000);
  assert.equal(activity(queued, { syncing: true }).kind, "unknown");
  assert.equal(activity(queued, { syncing: true }).since, undefined);
  assert.equal(activity({ ...queued, status: "stopped" }).kind, "ended");
  for (const phase of ["dispatched", "paused"] as const) {
    assert.equal(activity(run([node({ phase, queue: { cause: "actor-fifo" } })])).kind, phase);
  }
});

test("the latest observed delivery survives the next ask while current statistics reset", () => {
  const previous = node({ phase: "settled", outcome: "ok", settledAt: 2_000 });
  const next = node({
    ordinal: 2,
    activity: { ...observed, observedAt: 3_000, requestsCompleted: 0, toolCalls: 0 },
  });
  const value = activity(run([previous, next]));
  assert.equal(value.kind, "model");
  assert.equal(value.deliveredAt, 2_000);
  assert.equal(value.observedAt, 3_000);
  assert.equal(value.requestsCompleted, 0);
  assert.equal(value.toolCalls, 0);
  const legacy = activity(run([previous, { ...next, activity: undefined }]));
  assert.equal(legacy.deliveredAt, 2_000);
  assert.equal(legacy.requestsCompleted, undefined);
  assert.equal(legacy.observedAt, undefined);
});

test("delivery crosses this actor's phases but never actor identities or later phase observations", () => {
  const previous = node({ phase: "settled", outcome: "ok", settledAt: 2_000 });
  const otherSite = node({
    siteId: "other-ask",
    actorSiteId: "actor#other",
    phase: "settled",
    outcome: "ok",
    settledAt: 7_000,
  });
  const otherInstance = node({
    ordinal: 9,
    actorOrdinal: 2,
    phase: "settled",
    outcome: "ok",
    settledAt: 8_000,
  });
  const next = node({
    ordinal: 2,
    phaseName: "Review",
    activity: { ...observed, observedAt: 9_000, requestsCompleted: 1 },
  });
  const current = run([previous, otherSite, otherInstance, next], { currentPhase: "Review" });
  const model = buildWorkflowTimeline(graph, current);
  assert.equal(model.stations[1]!.pills[0]!.activity?.deliveredAt, 2_000);
  assert.equal(model.stations[1]!.pills[0]!.activity?.observedAt, 9_000);
  assert.equal(model.stations[1]!.pills[0]!.activity?.requestsCompleted, 1);
  assert.equal(model.stations[0]!.pills[0]!.activity?.deliveredAt, 2_000);
  assert.equal(model.stations[0]!.pills[0]!.activity?.observedAt, observed.observedAt);
  const finished = buildWorkflowTimeline(
    graph,
    run([previous, { ...next, phase: "settled", outcome: "ok", settledAt: 10_000 }], {
      status: "completed",
    }),
  );
  assert.equal(finished.stations[0]!.pills[0]!.activity?.deliveredAt, 2_000);
  assert.equal(finished.stations[1]!.pills[0]!.activity?.deliveredAt, 10_000);
  const future = buildWorkflowTimeline(graph, run([previous]));
  assert.equal(future.stations[1]!.pills[0]!.activity?.deliveredAt, undefined);
  assert.equal(future.stations[1]!.pills[0]!.activity?.observedAt, undefined);
});

test("delivery uses only successful non-cached valid source times still present in the node window", () => {
  const previous = node({ phase: "settled", outcome: "ok", settledAt: 2_000 });
  const current = node({ ordinal: 20 });
  for (const patch of [
    { cached: true },
    { outcome: "failed" as const },
    { outcome: "cancelled" as const },
    ...[undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER].map(
      (settledAt) => ({ settledAt }),
    ),
  ]) {
    const rejected = node({
      ordinal: 2,
      phase: "settled",
      outcome: "ok",
      settledAt: 5_000,
      ...patch,
    });
    assert.equal(activity(run([previous, rejected, current])).deliveredAt, 2_000);
  }
  assert.equal(activity(run([previous, current], { truncated: true })).deliveredAt, 2_000);
  assert.equal(activity(run([current], { truncated: true })).deliveredAt, undefined);
});

test("multi-site candidates preserve projection FIFO and settled tie order, not caller grouping", () => {
  const first = node({
    siteId: "ask@first",
    ordinal: 7,
    phase: "queued",
    activity: undefined,
    queue: { cause: "run-capacity", since: 1_000 },
  });
  const second = node({
    siteId: "ask@second",
    ordinal: 1,
    phase: "queued",
    activity: undefined,
    queue: { cause: "actor-fifo", since: 2_000 },
  });
  const current = run([first, second]);
  const fifo = workflowPillActivity([second, { ...first }], current, true, false, {});
  assert.equal(fifo.kind, "run-capacity");
  assert.equal(fifo.since, 1_000);
  const completed = run([
    {
      ...first,
      phase: "settled",
      outcome: "ok",
      settledAt: 3_000,
      activity: { ...observed, observedAt: 4_000 },
    },
    {
      ...second,
      phase: "settled",
      outcome: "ok",
      settledAt: 3_000,
      activity: { ...observed, observedAt: 5_000 },
    },
  ]);
  const latest = workflowPillActivity([...completed.nodes].reverse(), completed, true, false, {});
  assert.equal(latest.observedAt, 5_000, "equal settled timestamps pick the last observed node");
  assert.equal(latest.deliveredAt, 3_000);
});

test("indexes never retain delivery outside a replaced window or swallow display and run status changes", () => {
  const delivered = node({ phase: "settled", outcome: "ok", settledAt: 2_000 });
  const active = node({ ordinal: 2, activity: { ...observed, observedAt: 3_000 } });
  const original = run([delivered, active]);
  const before = activity(original);
  assert.equal(before.deliveredAt, 2_000);
  for (const display of [{ syncing: true }, { stale: true }]) {
    const changed = activity(original, display);
    assert.equal(changed.kind, "unknown");
    assert.ok(changed.connection);
    assert.equal(changed.deliveredAt, 2_000);
    assert.equal(changed.observedAt, 3_000);
  }
  assert.equal(activity({ ...original, status: "stopped" }).kind, "ended");
  const cropped = { ...original, nodes: [active], truncated: true };
  assert.equal(activity(cropped).deliveredAt, undefined);
  const replacement = {
    ...cropped,
    nodes: [{ ...active, activity: { ...observed, observedAt: 9_000 } }],
  };
  assert.equal(activity(replacement).observedAt, 9_000);
  assert.deepEqual(
    activity(original),
    before,
    "visiting another snapshot does not rewrite prior facts",
  );
});

test("delivery without a complete actor identity belongs only to the selected node", () => {
  const first = node({ actorSiteId: undefined, phase: "settled", outcome: "ok", settledAt: 2_000 });
  const next = node({ ordinal: 2, actorSiteId: undefined });
  const current = run([first, next]);
  assert.equal(workflowPillActivity([next], current, true, false, {}).deliveredAt, undefined);
  assert.equal(workflowPillActivity([first], current, true, false, {}).deliveredAt, 2_000);
  assert.equal(
    workflowPillActivity([node({ siteId: "absent" })], current, true, false, {}).kind,
    "created",
  );
});
