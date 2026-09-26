import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandEnvelope } from "./command.js";
import {
  executionFailoverChangeCauseSchema,
  executionFailoverEligibleBackgroundWorkIdsSchema,
  executionFailoverStateSchema,
  MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS,
  MAX_EXECUTION_FAILOVER_TARGETS,
  setExecutionFailoverTargetPayloadSchema,
} from "./execution-failover.js";

const modelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high", speed: "fast" },
};

test("failover target requires a bounded unique active execution target", () => {
  assert.equal(
    setExecutionFailoverTargetPayloadSchema.safeParse({
      modelSelection,
      observedTargets: { backgroundWorkIds: [] },
    }).success,
    false,
  );
  assert.equal(
    setExecutionFailoverTargetPayloadSchema.safeParse({
      modelSelection,
      observedTargets: { backgroundWorkIds: ["work-1", "work-1"] },
    }).success,
    false,
  );
  assert.equal(
    setExecutionFailoverTargetPayloadSchema.safeParse({
      modelSelection,
      observedTargets: {
        foregroundExecutionId: "execution-1",
        backgroundWorkIds: ["work-1"],
      },
    }).success,
    true,
  );
  assert.equal(
    setExecutionFailoverTargetPayloadSchema.safeParse({
      modelSelection,
      observedTargets: {
        backgroundWorkIds: Array.from({ length: 64 }, (_, index) => `work-${index}`),
      },
    }).success,
    true,
  );
  assert.equal(
    setExecutionFailoverTargetPayloadSchema.safeParse({
      modelSelection,
      observedTargets: {
        backgroundWorkIds: Array.from({ length: 65 }, (_, index) => `work-${index}`),
      },
    }).success,
    false,
  );
});

test("failover eligible targets are bounded, unique, and have a dedicated change cause", () => {
  assert.equal(
    executionFailoverChangeCauseSchema.safeParse("eligibleTargetsChanged").success,
    true,
  );
  assert.equal(
    executionFailoverEligibleBackgroundWorkIdsSchema.safeParse(
      Array.from({ length: 64 }, (_, index) => `actor-${index}`),
    ).success,
    true,
  );
  assert.equal(
    executionFailoverEligibleBackgroundWorkIdsSchema.safeParse(["actor-1", "actor-1"]).success,
    false,
  );
  assert.equal(
    executionFailoverEligibleBackgroundWorkIdsSchema.safeParse(
      Array.from({ length: 65 }, (_, index) => `actor-${index}`),
    ).success,
    false,
  );
});

test("setExecutionFailoverTarget is admitted without conversation revision CAS", () => {
  const parsed = parseCommandEnvelope({
    commandId: "command-1",
    clientId: "client-1",
    sessionId: "session-1",
    type: "setExecutionFailoverTarget",
    payload: {
      modelSelection,
      observedTargets: { foregroundExecutionId: "execution-1", backgroundWorkIds: [] },
    },
    issuedAt: 1,
  });
  assert.equal(parsed.ok, true);
});

test("failover projection distinguishes waiting handoff from safe-boundary activation", () => {
  const waiting = executionFailoverStateSchema.parse({
    revision: 1,
    sourceCommandId: "command-1",
    modelSelection,
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
  });
  const active = executionFailoverStateSchema.parse({
    ...waiting,
    revision: 2,
    targets: waiting.targets.map((target) => ({ ...target, status: "active" as const })),
    lastTransition: {
      targetKind: "foregroundExecution",
      targetId: "execution-1",
      from: { providerId: "provider-a", modelId: "model-a" },
      to: modelSelection,
      reasonCode: "userRequested",
      attempt: 1,
      at: 20,
    },
    updatedAt: 20,
  });
  assert.equal(waiting.targets[0]?.status, "waitingSafeBoundary");
  assert.equal(active.targets[0]?.status, "active");
});

test("failover state capacity includes one foreground plus every admitted background target", () => {
  const targets = [
    {
      kind: "foregroundExecution" as const,
      id: "execution-1",
      status: "waitingSafeBoundary" as const,
    },
    ...Array.from({ length: MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS }, (_, index) => ({
      kind: "backgroundWork" as const,
      id: `work-${index}`,
      status: "waitingSafeBoundary" as const,
    })),
  ];
  assert.equal(targets.length, MAX_EXECUTION_FAILOVER_TARGETS);
  assert.equal(
    executionFailoverStateSchema.safeParse({
      revision: 1,
      sourceCommandId: "command-capacity",
      modelSelection,
      foregroundExecutionId: "execution-1",
      targets,
      updatedAt: 10,
    }).success,
    true,
  );
  assert.equal(
    executionFailoverStateSchema.safeParse({
      revision: 1,
      sourceCommandId: "command-over-capacity",
      modelSelection,
      foregroundExecutionId: "execution-1",
      targets: [...targets, { kind: "backgroundWork", id: "overflow", status: "active" }],
      targetCount: targets.length + 1,
      targetsTruncated: true,
      updatedAt: 10,
    }).success,
    false,
  );
});
