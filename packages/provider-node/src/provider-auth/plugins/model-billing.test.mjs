import assert from "node:assert/strict";
import test from "node:test";
import { modelList } from "./compatibility.mjs";
const provider = { api: "https://fixture.invalid/v1" };

test("catalog preserves multipliers, explicit free and original rates without treating cost placeholders as free", () => {
  const result = modelList(provider, {
    quarter: { rate: 0.25, free: false },
    discount: { rate: 0.71, rateWas: 1 },
    free: { rate: 0, free: true },
    unknown: { cost: { input: 0, output: 0 }, rate: 0, free: false },
  });
  assert.deepEqual(result[0].billing, { kind: "multiplier", multiplier: 0.25 });
  assert.deepEqual(result[1].billing, {
    kind: "multiplier",
    multiplier: 0.71,
    originalMultiplier: 1,
  });
  assert.deepEqual(result[2].billing, { kind: "multiplier", multiplier: 0, free: true });
  assert.equal(result[3].billing, undefined);
});

test("invalid vendor prices never become a free or negative offer", () => {
  for (const rate of [-1, Infinity, NaN, "0.25"]) {
    const [result] = modelList(provider, { model: { rate, rateWas: -2, free: false } });
    assert.equal(result.billing, undefined);
  }
});
