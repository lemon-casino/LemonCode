import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry, type Provider } from "@zcode/provider";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { resolveRegistryOwnedSelection } from "./provider-registry-selection.js";

const registry = new ProviderRegistry([
  {
    providerId: "custom",
    models: [
      {
        modelId: "example",
        config: {
          properties: {},
          optionSpecs: {
            reasoningLevel: { values: ["low", "high"] },
            speed: { values: ["standard", "fast"] },
          },
        },
      },
    ],
  } as unknown as Provider,
]);

test("legacy model switch completes default reasoning and speed", () => {
  const selected = resolveRegistryOwnedSelection(registry, "custom/example");
  assert.deepEqual(selected?.selection, {
    providerId: "custom",
    modelId: "example",
    options: { reasoningLevel: "high", speed: "standard" },
  });
});

test("main model preserves a valid configured speed", () => {
  const selected = resolveRegistryOwnedSelection(registry, "main", {
    providerId: "custom",
    modelId: "example",
    options: { reasoningLevel: "low", speed: "fast" },
  });
  assert.deepEqual(selected?.selection.options, { reasoningLevel: "low", speed: "fast" });
});

test("workflow model catalog publishes the model default speed", () => {
  const catalog = createModelCatalogPort({ registry, currentSelection: () => undefined });
  assert.equal(catalog.listModels()[0]?.defaultSpeed, "standard");
});
