import assert from "node:assert/strict";
import test from "node:test";
import { compileModelOptionMaps } from "@lcode/model-option-map";
import type { AuthModel } from "./driver.js";
import { createAuthModelOptionSpecs } from "./model-options.js";

const base: AuthModel = {
  id: "m",
  name: "Model",
  protocol: "anthropic-messages",
  baseURL: "https://fixture.invalid",
};
test("OAuth model variants send selected thinking budget and maximum output through the existing map", () => {
  const specs = createAuthModelOptionSpecs({
    ...base,
    maxOutputTokens: 32000,
    reasoningVariants: [
      { id: "high", options: { thinking: { type: "enabled", budgetTokens: 16000 } } },
      { id: "low", options: { thinking: { type: "enabled", budgetTokens: 4000 } } },
    ],
  });
  assert.deepEqual(specs.reasoningLevel.values, ["default", "low", "high"]);
  assert.equal(specs.maxOutputTokens.max, 32000);
  assert.deepEqual(
    structuredClone(
      compileModelOptionMaps(specs).apply({}, { reasoningLevel: "low", maxOutputTokens: 8000 }),
    ),
    {
      thinking: { type: "enabled", budget_tokens: 4000 },
      max_tokens: 8000,
    },
  );
});
test("OAuth native efforts and service tiers preserve actual Responses request parameters", () => {
  const specs = createAuthModelOptionSpecs({
    ...base,
    protocol: "openai-responses",
    reasoningEfforts: ["high", "low"],
    serviceTiers: ["priority"],
  });
  assert.deepEqual(specs.reasoningLevel.values, ["default", "low", "high"]);
  assert.deepEqual(
    structuredClone(
      compileModelOptionMaps(specs).apply(
        {},
        { reasoningLevel: "high", maxOutputTokens: 4096, speed: "priority" },
      ),
    ),
    {
      reasoning: { effort: "high" },
      max_output_tokens: 4096,
      service_tier: "priority",
    },
  );
});
test("OAuth unknown defaults do not advertise fabricated effort or speed choices", () => {
  const specs = createAuthModelOptionSpecs(base);
  assert.deepEqual(specs.reasoningLevel.values, ["default"]);
  assert.equal(specs.speed, undefined);
  assert.deepEqual(
    structuredClone(
      compileModelOptionMaps(specs).apply({}, { reasoningLevel: "default", maxOutputTokens: 1024 }),
    ),
    { max_tokens: 1024 },
  );
});

test("Google catalog thinking options reach the shared Anthropic wire adapter", () => {
  const specs = createAuthModelOptionSpecs({
    ...base,
    reasoningVariants: [
      { id: "high", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
      { id: "low", options: { thinkingConfig: { thinkingBudget: 4096 } } },
    ],
  });
  const mapping = compileModelOptionMaps(specs);
  assert.deepEqual(
    structuredClone(mapping.apply({}, { reasoningLevel: "high", maxOutputTokens: 16000 })),
    {
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      max_tokens: 16000,
    },
  );
  assert.deepEqual(
    structuredClone(mapping.apply({}, { reasoningLevel: "low", maxOutputTokens: 16000 })),
    {
      thinking: { type: "enabled", budget_tokens: 4096 },
      max_tokens: 16000,
    },
  );
});
