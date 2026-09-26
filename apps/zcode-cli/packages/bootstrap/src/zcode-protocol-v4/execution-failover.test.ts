import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionFailoverChangedPayload, SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { ExecutionFailoverState } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";

const waitingState: ExecutionFailoverState = {
  revision: 1,
  sourceCommandId: "command-1",
  modelSelection: { providerId: "provider-b", modelId: "model-b" },
  foregroundExecutionId: "execution-1",
  targets: [
    {
      kind: "foregroundExecution",
      id: "execution-1",
      status: "waitingSafeBoundary",
      currentSelection: { providerId: "provider-a", modelId: "model-a" },
    },
  ],
  updatedAt: 10,
};

function failoverEvent(
  sequenceNumber: number,
  payload: ExecutionFailoverChangedPayload,
): SessionEvent {
  return {
    id: `event-${sequenceNumber}` as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    type: SessionEventType.ExecutionFailoverChanged,
    timestamp: new Date(sequenceNumber),
    traceId: "trace-1" as SessionEvent["traceId"],
    sequenceNumber,
    payload,
  };
}

test("projection applies failover state without bumping conversation revision", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, []);
  const deltas = projection.applyEvent(
    failoverEvent(1, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-1",
      state: waitingState,
    }),
  );
  assert.deepEqual(deltas, [{ op: "state.updated", patch: { executionFailover: waitingState } }]);
  assert.equal(projection.getSnapshot().revision, 0);
  assert.equal(
    projection.getSnapshot().executionFailover?.targets[0]?.status,
    "waitingSafeBoundary",
  );
});

test("projection atomically replaces failover policy and eligible background work ids", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  const deltas = projection.applyEvent(
    failoverEvent(1, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-1",
      state: waitingState,
      eligibleBackgroundWorkIds: ["actor-1", "actor-2"],
    }),
  );
  assert.deepEqual(deltas, [
    {
      op: "state.updated",
      patch: {
        executionFailover: waitingState,
        executionFailoverEligibleBackgroundWorkIds: ["actor-1", "actor-2"],
      },
    },
  ]);
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, [
    "actor-1",
    "actor-2",
  ]);
});

test("legacy failover events leave the projected eligible target list unchanged", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.applyEvent(
    failoverEvent(1, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-1",
      state: waitingState,
      eligibleBackgroundWorkIds: ["actor-1"],
    }),
  );
  const nextState: ExecutionFailoverState = {
    ...waitingState,
    revision: 2,
    updatedAt: 20,
  };
  const deltas = projection.applyEvent(
    failoverEvent(2, {
      revision: 2,
      cause: "safeBoundaryActivated",
      sourceCommandId: "command-1",
      state: nextState,
    }),
  );
  assert.deepEqual(deltas, [{ op: "state.updated", patch: { executionFailover: nextState } }]);
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, [
    "actor-1",
  ]);
});

test("an eligibility-only event may omit sourceCommandId when no policy exists", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  const deltas = projection.applyEvent(
    failoverEvent(1, {
      revision: 1,
      cause: "eligibleTargetsChanged",
      state: null,
      eligibleBackgroundWorkIds: ["actor-1"],
    }),
  );
  assert.deepEqual(deltas, [
    {
      op: "state.updated",
      patch: {
        executionFailover: null,
        executionFailoverEligibleBackgroundWorkIds: ["actor-1"],
      },
    },
  ]);
});

test("a non-empty failover policy requires a matching sourceCommandId", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  assert.deepEqual(
    projection.applyEvent(
      failoverEvent(1, {
        revision: 1,
        cause: "userRequested",
        state: waitingState,
        eligibleBackgroundWorkIds: ["actor-stale"],
      }),
    ),
    [],
  );
  assert.deepEqual(
    projection.applyEvent(
      failoverEvent(2, {
        revision: 1,
        cause: "userRequested",
        sourceCommandId: "command-other",
        state: waitingState,
        eligibleBackgroundWorkIds: ["actor-stale"],
      }),
    ),
    [],
  );
  const accepted = projection.applyEvent(
    failoverEvent(3, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-1",
      state: waitingState,
      eligibleBackgroundWorkIds: ["actor-live"],
    }),
  );
  assert.equal(accepted.length, 1);
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, [
    "actor-live",
  ]);
});

test("projection keeps a tombstone revision after clear and ignores stale policy events", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.applyEvent(
    failoverEvent(1, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-1",
      state: waitingState,
      eligibleBackgroundWorkIds: ["actor-old"],
    }),
  );
  projection.applyEvent(
    failoverEvent(2, {
      revision: 2,
      cause: "targetsCompleted",
      sourceCommandId: "command-1",
      state: null,
      eligibleBackgroundWorkIds: ["actor-current"],
    }),
  );
  const stale = projection.applyEvent(
    failoverEvent(3, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-1",
      state: waitingState,
      eligibleBackgroundWorkIds: ["actor-stale"],
    }),
  );
  assert.equal(projection.getSnapshot().executionFailover, null);
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, [
    "actor-current",
  ]);
  assert.deepEqual(stale, []);
});

test("runtime resume resets the failover revision scope for the new epoch", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  const oldEpochState: ExecutionFailoverState = {
    ...waitingState,
    revision: 8,
    sourceCommandId: "command-old",
  };
  projection.applyEvent(
    failoverEvent(1, {
      revision: 8,
      cause: "userRequested",
      sourceCommandId: "command-old",
      state: oldEpochState,
      eligibleBackgroundWorkIds: ["actor-old"],
    }),
  );
  const resumeDeltas = projection.applyEvent({
    id: "event-resume" as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    type: SessionEventType.SessionResumed,
    timestamp: new Date(2),
    traceId: "trace-2" as SessionEvent["traceId"],
    sequenceNumber: 2,
    payload: {},
  });
  assert.deepEqual(resumeDeltas, [
    {
      op: "state.updated",
      patch: {
        executionFailover: null,
        executionFailoverEligibleBackgroundWorkIds: [],
      },
    },
  ]);
  assert.equal(projection.getSnapshot().executionFailover, null);
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, []);
  const newEpochState: ExecutionFailoverState = {
    ...waitingState,
    sourceCommandId: "command-new",
  };
  const deltas = projection.applyEvent(
    failoverEvent(3, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-new",
      state: newEpochState,
      eligibleBackgroundWorkIds: ["actor-new"],
    }),
  );
  assert.equal(deltas.length, 1);
  assert.equal(projection.getSnapshot().executionFailover?.sourceCommandId, "command-new");
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, [
    "actor-new",
  ]);
});

test("runtime resume rejects old-epoch failover events even when their revision is higher", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.applyEventAtomically(
    {
      id: "event-resume" as SessionEvent["id"],
      sessionId: "session-1" as SessionEvent["sessionId"],
      type: SessionEventType.SessionResumed,
      timestamp: new Date(10),
      traceId: "trace-2" as SessionEvent["traceId"],
      sequenceNumber: 10,
      payload: {},
    },
    () => true,
  );
  const staleState: ExecutionFailoverState = {
    ...waitingState,
    revision: 99,
    sourceCommandId: "command-stale",
  };
  assert.deepEqual(
    projection.applyEvent(
      failoverEvent(9, {
        revision: 99,
        cause: "userRequested",
        sourceCommandId: "command-stale",
        state: staleState,
        eligibleBackgroundWorkIds: ["actor-stale"],
      }),
    ),
    [],
  );
  assert.equal(projection.getSnapshot().executionFailover, null);
  assert.deepEqual(projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds, []);

  const accepted = projection.applyEvent(
    failoverEvent(11, {
      revision: 1,
      cause: "userRequested",
      sourceCommandId: "command-new",
      state: { ...waitingState, sourceCommandId: "command-new" },
      eligibleBackgroundWorkIds: ["actor-new"],
    }),
  );
  assert.equal(accepted.length, 1);
  assert.equal(projection.getSnapshot().executionFailover?.sourceCommandId, "command-new");
});

test("runtime resume publishes the eligible target capability marker for a legacy snapshot", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  delete projection.getSnapshot().executionFailoverEligibleBackgroundWorkIds;

  const deltas = projection.applyEvent({
    id: "event-resume" as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    type: SessionEventType.SessionResumed,
    timestamp: new Date(1),
    traceId: "trace-2" as SessionEvent["traceId"],
    sequenceNumber: 1,
    payload: {},
  });
  assert.deepEqual(deltas, [
    {
      op: "state.updated",
      patch: {
        executionFailover: null,
        executionFailoverEligibleBackgroundWorkIds: [],
      },
    },
  ]);
});
