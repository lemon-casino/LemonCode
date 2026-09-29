import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import { inputIntentMetadataFromCanonical } from "./input-intent.js";

const envelope: CommandEnvelope = {
  commandId: "edit-command-1",
  clientId: "client-1",
  sessionId: "session-1",
  baseRevision: 4,
  baseLogEpoch: "epoch-1",
  type: "editUserQuery",
  payload: {
    target: { rowId: 7, entityId: "user-7" },
    newText: "edited prompt",
  },
  issuedAt: 1,
};

const historicalSelection = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "medium", speed: "standard" },
};
const submittedSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high", speed: "fast" },
};

function canonical(modelSelection = historicalSelection) {
  return {
    kind: "sendText" as const,
    text: "original prompt",
    sourceCommandId: "original-command",
    clientId: "client-1",
    queueItemId: "queue-original",
    modelSelection,
    requestedDelivery: "startNow" as const,
    admittedDelivery: "startNow" as const,
  };
}

test("canonical edit intent uses the submitted model selection override", () => {
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    { ...canonical(), modelSelection: submittedSelection },
    "edited prompt",
  );

  assert.equal(intent.text, "edited prompt");
  assert.deepEqual(intent.modelSelection, submittedSelection);
});

test("canonical edit intent keeps historical selection for legacy edits", () => {
  const intent = inputIntentMetadataFromCanonical(envelope, canonical(), "legacy edit");

  assert.deepEqual(intent.modelSelection, historicalSelection);
});
