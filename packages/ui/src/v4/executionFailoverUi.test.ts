import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionFailoverCommandPayload,
  captureExecutionFailoverTargets,
  resolveExecutionSwitchDisplay,
} from "./executionFailoverUi.js";

function snapshot(input?: {
  foregroundExecutionIds?: Array<string | undefined>;
  eligibleBackgroundWorkIds?: string[];
  backgroundWorks?: Array<{
    workId: string;
    kind: "bash" | "subagent" | "workflow";
    status: "running" | "resultPending" | "failed" | "cancelled";
  }>;
  runningSubagentIds?: string[];
  workflowRuns?: Array<{
    status: "pending" | "running" | "completed" | "errored" | "stopped";
    subagentModel?: string;
    actors: Array<{
      siteId: string;
      ordinal: number;
      sessionId?: string;
      status: "waiting" | "running" | "completed";
    }>;
  }>;
}) {
  return {
    control: {
      activeWorks: (input?.foregroundExecutionIds ?? []).map((foregroundExecutionId) => ({
        kind: "primaryTurn" as const,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        startedAt: 1,
      })),
    },
    backgroundWorks: (input?.backgroundWorks ?? []).map((work) => ({
      ...work,
      title: work.workId,
      startedAt: 1,
      anchorRowId: null,
    })),
    subagents: {
      running: (input?.runningSubagentIds ?? []).map((childSessionId) => ({
        childSessionId,
      })),
    },
    workflowRuns: {
      revision: 1,
      runs: input?.workflowRuns ?? [],
    },
    ...(input?.eligibleBackgroundWorkIds === undefined
      ? {}
      : {
          executionFailoverEligibleBackgroundWorkIds: input.eligibleBackgroundWorkIds,
        }),
  };
}

test("captures the foreground execution and running subagent work targets", () => {
  assert.deepEqual(
    captureExecutionFailoverTargets(
      snapshot({
        foregroundExecutionIds: [undefined, " execution-2 "],
        backgroundWorks: [
          { workId: "subagent-1", kind: "subagent", status: "running" },
          { workId: "bash-1", kind: "bash", status: "running" },
          { workId: "subagent-2", kind: "subagent", status: "resultPending" },
        ],
      }),
    ),
    {
      foregroundExecutionId: "execution-2",
      backgroundWorkIds: ["subagent-1"],
    },
  );
});

test("does not create a command target when no eligible execution is active", () => {
  assert.equal(
    captureExecutionFailoverTargets(
      snapshot({
        backgroundWorks: [
          { workId: "bash-1", kind: "bash", status: "running" },
          { workId: "subagent-1", kind: "subagent", status: "failed" },
        ],
      }),
    ),
    null,
  );
  assert.equal(captureExecutionFailoverTargets(null), null);
});

test("deduplicates running subagent work ids while preserving snapshot order", () => {
  assert.deepEqual(
    captureExecutionFailoverTargets(
      snapshot({
        backgroundWorks: [
          { workId: " work-2 ", kind: "subagent", status: "running" },
          { workId: "work-1", kind: "subagent", status: "running" },
          { workId: "work-2", kind: "subagent", status: "running" },
        ],
      }),
    ),
    { backgroundWorkIds: ["work-2", "work-1"] },
  );
});

test("uses authoritative eligible ids and does not derive targets from workflowRuns", () => {
  assert.deepEqual(
    captureExecutionFailoverTargets(
      snapshot({
        backgroundWorks: [
          { workId: "work-1", kind: "subagent", status: "running" },
          { workId: "shared-id", kind: "subagent", status: "running" },
        ],
        eligibleBackgroundWorkIds: [" actor-session-1 ", "shared-id", "actor-completed"],
        workflowRuns: [
          {
            status: "running",
            actors: [
              {
                siteId: "actor-running",
                ordinal: 0,
                sessionId: "inferred-only-live-actor",
                status: "running",
              },
            ],
          },
          {
            status: "completed",
            actors: [
              {
                siteId: "actor-terminal-run",
                ordinal: 0,
                sessionId: "actor-terminal-run",
                status: "running",
              },
            ],
          },
          {
            status: "running",
            subagentModel: "provider-explicit/model-explicit",
            actors: [
              {
                siteId: "actor-explicit-run",
                ordinal: 0,
                sessionId: "actor-explicit-run",
                status: "running",
              },
            ],
          },
        ],
      }),
    ),
    {
      backgroundWorkIds: ["actor-session-1", "shared-id", "actor-completed", "work-1"],
    },
  );
});

test("an empty authoritative eligibility list does not fall back to workflowRuns", () => {
  assert.equal(
    captureExecutionFailoverTargets(
      snapshot({
        eligibleBackgroundWorkIds: [],
        workflowRuns: [
          {
            status: "running",
            actors: [
              {
                siteId: "reusable-actor",
                ordinal: 0,
                sessionId: "must-not-be-inferred",
                status: "running",
              },
            ],
          },
        ],
      }),
    ),
    null,
  );
});

test("a legacy snapshot without eligibility does not infer workflow actors", () => {
  assert.equal(
    captureExecutionFailoverTargets(
      snapshot({
        workflowRuns: [
          {
            status: "running",
            actors: [
              {
                siteId: "actor",
                ordinal: 0,
                sessionId: "legacy-inferred-actor",
                status: "running",
              },
            ],
          },
        ],
      }),
    ),
    null,
  );
});

test("does not treat the subagent directory as a workflow actor target", () => {
  assert.equal(
    captureExecutionFailoverTargets(snapshot({ runningSubagentIds: ["directory-only-session"] })),
    null,
  );
});

test("new snapshots prioritize eligible ids and support positions 33 through 64 without foreground", () => {
  const observed = captureExecutionFailoverTargets(
    snapshot({
      eligibleBackgroundWorkIds: Array.from({ length: 40 }, (_, index) => `eligible-${index}`),
      backgroundWorks: Array.from({ length: 40 }, (_, index) => ({
        workId: `work-${index}`,
        kind: "subagent" as const,
        status: "running" as const,
      })),
    }),
  );

  assert.equal(observed?.backgroundWorkIds.length, 64);
  assert.equal(observed?.backgroundWorkIds[0], "eligible-0");
  assert.equal(observed?.backgroundWorkIds[39], "eligible-39");
  assert.equal(observed?.backgroundWorkIds[40], "work-0");
  assert.equal(observed?.backgroundWorkIds.at(-1), "work-23");
});

test("new snapshots prioritize ordinary running work when foreground is active", () => {
  const observed = captureExecutionFailoverTargets(
    snapshot({
      foregroundExecutionIds: ["foreground-1"],
      eligibleBackgroundWorkIds: Array.from({ length: 40 }, (_, index) => `eligible-${index}`),
      backgroundWorks: Array.from({ length: 40 }, (_, index) => ({
        workId: `work-${index}`,
        kind: "subagent" as const,
        status: "running" as const,
      })),
    }),
  );

  assert.equal(observed?.foregroundExecutionId, "foreground-1");
  assert.equal(observed?.backgroundWorkIds.length, 64);
  assert.equal(observed?.backgroundWorkIds[0], "work-0");
  assert.equal(observed?.backgroundWorkIds[39], "work-39");
  assert.equal(observed?.backgroundWorkIds[40], "eligible-0");
  assert.equal(observed?.backgroundWorkIds.at(-1), "eligible-23");
});

test("legacy snapshots retain the 32 ordinary-work compatibility limit", () => {
  const observed = captureExecutionFailoverTargets(
    snapshot({
      backgroundWorks: Array.from({ length: 40 }, (_, index) => ({
        workId: `legacy-work-${index}`,
        kind: "subagent" as const,
        status: "running" as const,
      })),
    }),
  );

  assert.equal(observed?.backgroundWorkIds.length, 32);
  assert.equal(observed?.backgroundWorkIds[0], "legacy-work-0");
  assert.equal(observed?.backgroundWorkIds.at(-1), "legacy-work-31");
});

test("does not build a failover command while the execution is idle", () => {
  assert.equal(
    buildExecutionFailoverCommandPayload(snapshot(), {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "medium", speed: "fast" },
    }),
    null,
  );
});

test("builds an active failover command with the complete updated selection", () => {
  const modelSelection = {
    providerId: "provider-b",
    modelId: "model-b",
    options: { reasoningLevel: "medium", speed: "standard" },
  };

  assert.deepEqual(
    buildExecutionFailoverCommandPayload(
      snapshot({ foregroundExecutionIds: ["execution-1"] }),
      modelSelection,
    ),
    {
      modelSelection,
      observedTargets: {
        foregroundExecutionId: "execution-1",
        backgroundWorkIds: [],
      },
    },
  );
});

test("prefers the foreground target that is waiting for a safe boundary", () => {
  const targetSelection = { providerId: "provider-b", modelId: "model-b" };
  const sessionSelection = { providerId: "provider-a", modelId: "model-a" };

  assert.deepEqual(
    resolveExecutionSwitchDisplay(
      {
        modelSelection: targetSelection,
        targets: [
          {
            kind: "backgroundWork",
            id: "work-active",
            status: "active",
            currentSelection: targetSelection,
          },
          {
            kind: "foregroundExecution",
            id: "execution-waiting",
            status: "waitingSafeBoundary",
            currentSelection: sessionSelection,
          },
        ],
      },
      sessionSelection,
    ),
    {
      kind: "waitingSafeBoundary",
      currentSelection: sessionSelection,
      targetSelection,
    },
  );
});

test("uses the matching transition when a safe switch is active", () => {
  const from = { providerId: "provider-a", modelId: "model-a" };
  const to = { providerId: "provider-b", modelId: "model-b" };

  assert.deepEqual(
    resolveExecutionSwitchDisplay(
      {
        modelSelection: to,
        targets: [{ kind: "foregroundExecution", id: "execution-1", status: "active" }],
        lastTransition: {
          targetKind: "foregroundExecution",
          targetId: "execution-1",
          from,
          to,
        },
      },
      from,
    ),
    { kind: "active", from, to },
  );
});
