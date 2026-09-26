import assert from "node:assert/strict";
import test from "node:test";
import { updateDraftModelSelectionOption } from "./draftModelSelection.js";

const selection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high", speed: "fast" },
};
const modelContext = { provider: "provider-b", model: "model-b" };
const draftConfig = { modelSelection: selection };

test("reasoning changes preserve speed in the complete model selection", () => {
  assert.deepEqual(
    updateDraftModelSelectionOption(draftConfig, modelContext, "reasoningLevel", "medium"),
    {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "medium", speed: "fast" },
    },
  );
});

test("speed changes preserve reasoning in the complete model selection", () => {
  assert.deepEqual(
    updateDraftModelSelectionOption(draftConfig, modelContext, "speed", "standard"),
    {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high", speed: "standard" },
    },
  );
});

test("legacy provider and model fields remain a valid reasoning baseline", () => {
  assert.deepEqual(
    updateDraftModelSelectionOption(
      { provider: " provider-b ", model: " model-b " },
      modelContext,
      "reasoningLevel",
      "medium",
    ),
    {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "medium" },
    },
  );
});

test("stale model context cannot rewrite or arm a different model", () => {
  assert.equal(
    updateDraftModelSelectionOption(
      draftConfig,
      { provider: "provider-c", model: "model-c" },
      "reasoningLevel",
      "low",
    ),
    null,
  );
  assert.deepEqual(selection.options, { reasoningLevel: "high", speed: "fast" });
});
