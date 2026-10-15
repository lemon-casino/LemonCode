import assert from "node:assert/strict";
import test from "node:test";
import { copilotBilling } from "./copilot-billing.js";
test("Copilot uses account billing mode rather than treating token plans as request multipliers", () => {
  const billing = {
    multiplier: 0.25,
    tokenPrices: { inputPrice: 2, outputPrice: 4, batchSize: 1000 },
  };
  assert.deepEqual(copilotBilling(billing, true), {
    kind: "token-credits",
    input: 2,
    output: 4,
    batchSize: 1000,
  });
  assert.deepEqual(copilotBilling(billing, false), { kind: "multiplier", multiplier: 0.25 });
  assert.equal(copilotBilling({ multiplier: 0 }, true), undefined);
  assert.equal(copilotBilling({ multiplier: 0 }), undefined);
  assert.deepEqual(copilotBilling({ multiplier: 0 }, false), {
    kind: "multiplier",
    multiplier: 0,
    free: true,
  });
});
