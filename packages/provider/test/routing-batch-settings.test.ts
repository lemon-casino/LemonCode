import assert from "node:assert/strict";
import test from "node:test";
import { createMembershipFixture } from "./model-membership.fixture.js";
test("batch metadata commands are revision guarded, preserve credentials and save generation, and return redacted pages", async (t) => {
  const f = await createMembershipFixture(t);
  const original = f.repository.snapshot.providers.get("personal")!.toJSON();
  const keys = Array.from({ length: 300 }, (_, i) => ({
    id: `k${i}`,
    apiKey: `synthetic-secret-${i}`,
  }));
  await f.settings.savePersonalProviderOverlay("personal", {
    ...original,
    access: { type: "api-key", apiKeys: keys },
  });
  const oldForm = f.repository.snapshot.providers.get("personal")!.toJSON();
  const generations = { ...f.repository.snapshot.saveGenerations };
  const revision = f.settings.getView().revision;
  await f.settings.setApiKeyRoutingMetadata({
    providerId: "personal",
    expectedRevision: revision,
    target: { type: "all" },
    patch: { quotaPoolId: "team", weight: 3, cacheGroupId: "cache", cacheTtlMs: 60_000 },
  });
  assert.deepEqual(f.repository.snapshot.saveGenerations, generations);
  const page = f.settings.readApiKeyRoutingPage({ providerId: "personal", offset: 250, limit: 20 });
  assert.equal(page.source, "configuration");
  assert.equal(page.total, 300);
  assert.equal(page.rows.length, 20);
  assert.equal(page.rows[0]!.id, "k250");
  assert.equal(page.rows[0]!.routing?.weight, 3);
  assert.equal(JSON.stringify(page).includes("synthetic-secret"), false);
  await assert.rejects(
    f.settings.setApiKeyRoutingMetadata({
      providerId: "personal",
      expectedRevision: revision,
      target: { type: "all" },
      patch: null,
    }),
    /conflict/,
  );
  assert.throws(
    () => f.settings.readApiKeyRoutingPage({ providerId: "personal", expectedRevision: revision }),
    /conflict/,
  );
  await f.settings.savePersonalProviderOverlay("personal", oldForm);
  const current = f.repository.snapshot.providers.get("personal")!.access!;
  assert.equal(current.type, "api-key");
  assert.equal("apiKeys" in current && current.apiKeys![0]!.routing!.quotaPoolId, "team");
  const latest = f.settings.getView().revision;
  await f.settings.setApiKeyRoutingMetadata({
    providerId: "personal",
    expectedRevision: latest,
    target: { type: "ids", keyIds: ["k0"] },
    patch: { quotaPoolId: null, weight: 1 },
  });
  const final = f.settings.readApiKeyRoutingPage({ providerId: "personal", limit: 2 });
  assert.equal(final.rows[0]!.routing?.quotaPoolId, undefined);
  assert.equal(final.rows[1]!.routing?.quotaPoolId, "team");
});

test("unknown or duplicate Key IDs cannot partially patch a batch", async (t) => {
  const f = await createMembershipFixture(t);
  const revision = f.settings.getView().revision;
  await assert.rejects(
    f.settings.setApiKeyRoutingMetadata({
      providerId: "personal",
      expectedRevision: revision,
      target: { type: "ids", keyIds: ["missing"] },
      patch: { weight: 2 },
    }),
  );
  assert.throws(() =>
    f.settings.setApiKeyRoutingMetadata({
      providerId: "personal",
      expectedRevision: revision,
      target: { type: "ids", keyIds: ["missing", "missing"] },
      patch: { weight: 2 },
    }),
  );
  assert.equal(f.settings.getView().revision, revision);
});
