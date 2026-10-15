import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginAuthFixtureDriver } from "../plugins.js";

test("bundled WorkBuddy catalog carries live rates and offer expiry but never turns nightly pricing into all-day free", async (t) => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v3/config");
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        code: 0,
        data: {
          agents: [{ name: "cli", models: ["quarter", "discount", "promo", "night", "unknown"] }],
          models: [
            { id: "quarter", credits: "0.25" },
            { id: "discount", credits: "0.71" },
            { id: "promo", credits: "1" },
            { id: "night", credits: "0" },
            { id: "unknown" },
          ],
          modelPromotions: [
            {
              kind: "discount",
              modelIds: ["promo"],
              discount: { discountedCredits: "0.00x" },
              schedule: { validUntil: until },
            },
            {
              kind: "discount",
              modelIds: ["night"],
              discount: { discountedCredits: "0.00x" },
              schedule: { validUntil: until, daily: [{ from: "23:00", until: "08:00" }] },
            },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const driver = createPluginAuthFixtureDriver(
    "workbuddy",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  )!;
  t.after(async () => {
    await driver.dispose?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const models = await driver.models({
    read: async () => ({
      type: "oauth",
      access: "fixture",
      refresh: "fixture",
      uid: "fixture",
      expires: Date.now() + 3600_000,
    }),
    write: async () => {},
  });
  assert.deepEqual(models.find((m) => m.id === "quarter")?.billing, {
    kind: "multiplier",
    multiplier: 0.25,
  });
  assert.deepEqual(models.find((m) => m.id === "discount")?.billing, {
    kind: "multiplier",
    multiplier: 0.71,
  });
  assert.deepEqual(models.find((m) => m.id === "promo")?.billing, {
    kind: "multiplier",
    multiplier: 0,
    originalMultiplier: 1,
    free: true,
    validUntil: until,
  });
  assert.equal(models.find((m) => m.id === "night")?.billing, undefined);
  assert.equal(models.find((m) => m.id === "unknown")?.billing, undefined);
});
