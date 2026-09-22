import assert from "node:assert/strict";
import test from "node:test";
import {
  completeNewModelSelection,
  normalizeModelSelection,
  validateModelSelectionOptions,
} from "@zcode/provider";

const registry = {
  providers: [
    {
      providerId: "custom",
      models: [
        {
          modelId: "demo",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["disabled", "low", "high"] },
              speed: { values: ["standard", "fast"] },
            },
          },
        },
      ],
    },
  ],
};

test("new selections receive the highest reasoning level and standard speed", () => {
  assert.deepEqual(
    completeNewModelSelection(registry, { providerId: "custom", modelId: "demo" }),
    {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "high", speed: "standard" },
    },
  );
});

test("composer can request the highest speed for a new model without changing runtime defaults", () => {
  assert.deepEqual(
    completeNewModelSelection(registry, { providerId: "custom", modelId: "demo" }, { speed: "highest" }),
    {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  );
});

test("normalization preserves valid speed and removes an unsupported selection", () => {
  const valid = {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "low", speed: "fast" },
  } as const;
  assert.equal(normalizeModelSelection(registry, valid), valid);
  assert.deepEqual(
    normalizeModelSelection(registry, {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "low", speed: "turbo" },
    }),
    { providerId: "custom", modelId: "demo" },
  );
});

test("registry validation rejects a missing speed before execution", () => {
  assert.deepEqual(
    validateModelSelectionOptions(registry.providers[0]!.models[0]!, {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "high" },
    }),
    {
      ok: false,
      code: "speed-missing",
      providerId: "custom",
      modelId: "demo",
    },
  );
});
