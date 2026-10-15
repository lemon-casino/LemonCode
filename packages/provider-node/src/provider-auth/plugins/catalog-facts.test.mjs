import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogFacts } from "./catalog-facts.mjs";

test("catalog observes consumed config and expires whole-day offers only", async () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const facts = createCatalogFacts("workbuddy", new AbortController().signal, now);
  const offer = {
    kind: "discount",
    modelIds: ["free"],
    discount: { factor: 0 },
    schedule: { validUntil: "2026-10-16T00:00:00Z" },
  };
  const response = facts.observe(
    "https://example.test/v3/config",
    Response.json({
      data: {
        modelPromotions: [
          offer,
          { ...offer, modelIds: ["night"], schedule: { ...offer.schedule, daily: [{}] } },
          { ...offer, modelIds: ["expired"], schedule: { validUntil: "2026-10-14T00:00:00Z" } },
        ],
      },
    }),
  );
  await response.json();
  const list = facts.apply(
    ["free", "night", "expired", "unknown"].map((id) => ({
      id,
      ...(id !== "unknown" ? { billing: { kind: "multiplier", multiplier: 0, free: true } } : {}),
    })),
  );
  assert.equal(list[0].billing.validUntil, "2026-10-16T00:00:00.000Z");
  assert.equal(list[1].billing.validUntil, undefined);
  assert.equal(list[2].billing.validUntil, undefined);
  assert.equal(list[3].billing, undefined);
});
