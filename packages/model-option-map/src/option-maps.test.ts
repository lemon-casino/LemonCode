import assert from "node:assert/strict";
import test from "node:test";
import { compileModelOptionMaps } from "./option-maps.js";

test("speed map is applied after reasoning and output token maps", () => {
  const maps = compileModelOptionMaps({
    reasoningLevel: { map: '{"reasoning_effort": reasoningLevel}' },
    maxOutputTokens: { map: '{"max_output_tokens": maxOutputTokens}' },
    speed: {
      map: 'speed == "fast" ? {"service_tier": "priority"} : {"service_tier": "default"}',
    },
  });

  assert.deepEqual(
    structuredClone(
      maps.apply(
        { model: "demo" },
        { reasoningLevel: "high", maxOutputTokens: 4096, speed: "fast" },
      ),
    ),
    {
      model: "demo",
      reasoning_effort: "high",
      max_output_tokens: 4096,
      service_tier: "priority",
    },
  );
});

test("legacy specs without speed remain compatible", () => {
  const maps = compileModelOptionMaps({
    reasoningLevel: { map: "{}" },
    maxOutputTokens: { map: "{}" },
  });

  assert.deepEqual(
    structuredClone(
      maps.apply({ model: "demo" }, { reasoningLevel: "high", maxOutputTokens: 4096 }),
    ),
    { model: "demo" },
  );
});
