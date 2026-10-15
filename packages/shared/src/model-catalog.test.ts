import assert from "node:assert/strict";
import test from "node:test";
import { modelBillingSchema, mergeModelBilling, currentModelBilling } from "./model-catalog.js";

test("billing keeps exact zero distinct from unknown, rejects unsafe numbers and unknown fields", () => {
  assert.deepEqual(modelBillingSchema.parse({ kind: "multiplier", multiplier: 0, free: true }), {
    kind: "multiplier",
    multiplier: 0,
    free: true,
  });
  for (const multiplier of [-1, Infinity, NaN])
    assert.equal(modelBillingSchema.safeParse({ kind: "multiplier", multiplier }).success, false);
  assert.equal(modelBillingSchema.safeParse({ kind: "unknown", access: "secret" }).success, false);
  assert.equal(
    modelBillingSchema.safeParse({ kind: "multiplier", multiplier: 0.71, free: true }).success,
    false,
  );
  assert.equal(
    modelBillingSchema.safeParse({ kind: "multiplier", multiplier: 1, originalMultiplier: 0.25 })
      .success,
    false,
  );
});

test("a pool only presents a price shared by all accounts", () => {
  const a = { kind: "multiplier" as const, multiplier: 0.25 };
  assert.deepEqual(mergeModelBilling([a, a]), a);
  assert.deepEqual(mergeModelBilling([a, { ...a, multiplier: 0.71 }]), { kind: "mixed" });
  assert.deepEqual(mergeModelBilling([a, undefined]), { kind: "mixed" });
  assert.equal(mergeModelBilling([undefined, undefined]), undefined);
  assert.equal(mergeModelBilling([undefined, { kind: "unknown" }]), undefined);
});

test("a free promotion expires at its exact boundary and never becomes a permanent promise", () => {
  const until = "2026-10-16T00:00:00+08:00";
  const value = {
    kind: "multiplier" as const,
    multiplier: 0,
    free: true as const,
    originalMultiplier: 0.71,
    validUntil: until,
  };
  assert.deepEqual(currentModelBilling(value, Date.parse(until) - 1), value);
  assert.deepEqual(currentModelBilling(value, Date.parse(until)), {
    kind: "multiplier",
    multiplier: 0.71,
  });
  assert.deepEqual(
    currentModelBilling({ ...value, originalMultiplier: undefined }, Date.parse(until)),
    { kind: "unknown" },
  );
});
