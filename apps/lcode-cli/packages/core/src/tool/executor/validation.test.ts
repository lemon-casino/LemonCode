import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowToolEntry } from "../handlers/create-workflow.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import { validateInitialModelToolInput, validateInput } from "./validation.js";

const approvedInput = {
  script: 'return await agent("executor").ask("fixture task");',
  actor_model_overrides: [
    {
      siteId: "actor#1",
      selection: {
        providerId: "fixture-provider",
        modelId: "fixture-executor",
        options: { reasoningLevel: "high", speed: "fast" },
      },
    },
  ],
};

test("approval-only actor models pass runtime validation but fail model-authored admission", () => {
  const normalized = normalizeToolExecutionInput({
    entry: createWorkflowToolEntry,
    input: approvedInput,
    source: "permission",
  });
  assert.deepEqual(normalized, approvedInput);
  assert.equal(validateInput(normalized, createWorkflowToolEntry), undefined);
  assert.ok(validateInitialModelToolInput(approvedInput, createWorkflowToolEntry));
});

for (const [label, input] of [
  [
    "invalid ordinal",
    {
      ...approvedInput,
      actor_model_overrides: [{ ...approvedInput.actor_model_overrides[0], ordinal: 0 }],
    },
  ],
  [
    "invalid model options",
    {
      ...approvedInput,
      actor_model_overrides: [
        {
          siteId: "actor#1",
          selection: {
            providerId: "fixture-provider",
            modelId: "fixture-executor",
            options: { speed: "" },
          },
        },
      ],
    },
  ],
  [
    "unknown selection field",
    {
      ...approvedInput,
      actor_model_overrides: [
        {
          siteId: "actor#1",
          selection: {
            providerId: "fixture-provider",
            modelId: "fixture-executor",
            unexpected: true,
          },
        },
      ],
    },
  ],
  ["unknown runtime field", { ...approvedInput, unexpected: true }],
] as const) {
  test(`runtime validation rejects ${label}`, () => {
    assert.ok(validateInput(input, createWorkflowToolEntry));
  });
}

test("tools without a runtime schema keep JSON-schema execution input validation", () => {
  const entry = { ...createWorkflowToolEntry, runtimeInputSchema: undefined };
  assert.equal(validateInput({ script: approvedInput.script }, entry), undefined);
  assert.ok(validateInput(approvedInput, entry));
});
