import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionEvent,
  goalAcceptanceSchema,
  type SessionEvent,
  type SessionId,
  type MessageWithParts,
} from "@lcode/contracts";
import type { CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { inputIntentOfMessage } from "./transcript-hydration-input.js";
import { inputIntentMetadataFromCanonical } from "./commands/input-intent.js";

const sessionId = "projection-goal" as SessionId;
function event(type: SessionEvent["type"], payload: unknown, sequenceNumber: number) {
  return {
    ...createSessionEvent(type, sessionId, payload),
    sequenceNumber,
    timestamp: new Date(sequenceNumber),
  };
}
function goal(targetID: string) {
  return {
    targetID,
    objective: "task",
    status: "active",
    summaryTitle: null,
    timeUsedSeconds: 0,
    activeRunStartedAtMs: null,
  };
}
test("late verifier closes historical marker without overwriting a replaced goal on live or cold replay", () => {
  const facts = [
    event("target_changed", { action: "set", target: goal("old") }, 1),
    event(
      "target_completion_verification",
      { targetId: "old", verificationId: "v1", goalIteration: 1, status: "started" },
      2,
    ),
    event("target_changed", { action: "set", target: goal("new") }, 3),
    event(
      "target_completion_verification",
      {
        targetId: "old",
        verificationId: "v1",
        goalIteration: 1,
        status: "failed_closed",
        verification: { passed: false, reason: "stale old goal" },
      },
      4,
    ),
  ] as SessionEvent[];
  const live = new ProductProjection(sessionId, "epoch");
  const cold = new ProductProjection(sessionId, "epoch");
  cold.beginHydrationReplay();
  for (const fact of facts) {
    live.applyEvent(fact);
    cold.applyHydrationEvent(fact);
  }
  cold.completeHydrationReplay();
  assert.equal(live.getSnapshot().goal?.targetId, "new");
  assert.equal(live.getSnapshot().goal?.status, "active");
  assert.deepEqual(cold.getSnapshot().goal, live.getSnapshot().goal);
});
test("cold canonical strict goal input and its edit/retry preserve the frozen acceptance", () => {
  const acceptance = goalAcceptanceSchema.parse({
    policy: "strict",
    requirements: [
      {
        id: "check",
        description: "check",
        source: "Bash",
        command: "pnpm test",
        inputPaths: ["source.ts"],
      },
    ],
  });
  const intent = inputIntentOfMessage({
    info: {
      role: "user",
      metadata: {
        conversationInputIntent: {
          sourceCommandId: "original",
          queueItemId: "original",
          clientId: "client",
          kind: "sendGoalCommand",
          text: "task",
          goalAcceptance: acceptance,
          attachments: [],
          delivery: { requested: "startNow", admitted: "startNow" },
          order: { admissionSeq: 1 },
          steer: { state: "notRequested" },
          dispatch: { state: "drained" },
          admittedAt: 1,
        },
      },
    },
    parts: [],
  } as unknown as MessageWithParts);
  assert.deepEqual(intent?.goalAcceptance, acceptance);
  const envelope = {
    commandId: "retry",
    clientId: "client",
    sessionId,
    baseRevision: 1,
    baseLogEpoch: "epoch",
    type: "retryTurn",
    payload: {},
    issuedAt: 2,
  } as CommandEnvelope;
  const retried = inputIntentMetadataFromCanonical(
    envelope,
    { kind: "sendGoalCommand", text: "task", goalAcceptance: intent?.goalAcceptance },
    "edited task",
  );
  assert.deepEqual(retried.goalAcceptance, acceptance);
});
