import assert from "node:assert/strict";
import test from "node:test";
import { goalAcceptanceSchema } from "@lcode/contracts";
import { PROTOCOL_V4_LIMITS, type CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { measureInputAdmissionProjectionBytes } from "./conversation-topic-queries.js";

test("strict Goal input uses the same projected admission byte budget as legacy Goal", () => {
  const state = {
    logEpoch: "epoch",
    topic: "conversation/session",
    projection: new ProductProjection("session", "epoch"),
  };
  const admission = { admissionSeq: 1, admittedAt: 1, queueItemId: "goal" };
  const base = { commandId: "goal", clientId: "client", sessionId: "session", issuedAt: 1 };
  const text = "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes);
  const acceptance = goalAcceptanceSchema.parse({
    policy: "strict",
    requirements: [
      {
        id: "gate",
        description: "check",
        source: "Bash",
        command: "node check.mjs",
        inputPaths: ["check.mjs"],
      },
    ],
  });
  const legacy = measureInputAdmissionProjectionBytes(
    state,
    { ...base, type: "sendGoalCommand", payload: { text } } as CommandEnvelope,
    admission,
  );
  const strict = measureInputAdmissionProjectionBytes(
    state,
    { ...base, type: "sendStrictGoalCommand", payload: { text, acceptance } } as CommandEnvelope,
    admission,
  );
  assert.ok(strict);
  assert.ok(strict > legacy!);
  assert.ok(strict > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes);
});
