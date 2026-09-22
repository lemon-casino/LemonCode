import assert from "node:assert/strict";
import test from "node:test";
import { createComposerSubmissionConfig } from "./composerSubmissionConfig.js";

const view = {
  revision: 1,
  providers: [
    {
      providerId: "custom",
      providerName: "Custom",
      models: [
        {
          modelId: "demo",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
              maxOutputTokens: { max: 4096, map: "{}" },
              speed: { values: ["standard", "fast"], map: "{}" },
            },
          },
        },
      ],
    },
  ],
} as never;

test("submission freezes reasoning and speed from the composer draft", () => {
  const result = createComposerSubmissionConfig(
    {
      mode: "build",
      modelSelection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "high", speed: "fast" },
      },
    },
    view,
  );

  assert.deepEqual(result?.modelSelection, {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "high", speed: "fast" },
  });
  assert.equal(Object.isFrozen(result?.modelSelection.options), true);
});
