import assert from "node:assert/strict";
import test from "node:test";
import { createMembershipFixture, roundtrip } from "./model-membership.fixture.js";

test("routing mutation preserves keys, membership, defaults and save generation; stale revision cannot overwrite", async (t) => {
  const f = await createMembershipFixture(t);
  const original = f.repository.snapshot.providers.get("personal")!.toJSON();
  const generations = { ...f.repository.snapshot.saveGenerations };
  const revision = f.settings.getView().revision;
  const policy = { version: 1 as const, strategy: "primary-backup" as const };
  await f.settings.setProviderRouting({
    providerId: "personal",
    expectedRevision: revision,
    routing: policy,
  });
  assert.deepEqual(f.repository.snapshot.saveGenerations, generations);
  assert.deepEqual(
    f.repository.snapshot.providers.get("personal")!.access?.toJSON(),
    original.access,
  );
  assert.deepEqual(roundtrip(f.repository.snapshot).providers.get("personal")!.routing, policy);
  await assert.rejects(
    f.settings.setProviderRouting({
      providerId: "personal",
      expectedRevision: revision,
      routing: null,
    }),
    /conflict/,
  );
  await f.settings.savePersonalProviderOverlay("personal", original);
  assert.deepEqual(f.repository.snapshot.providers.get("personal")!.routing, policy);
  await f.settings.setProviderRouting({
    providerId: "personal",
    expectedRevision: f.settings.getView().revision,
    routing: null,
  });
  assert.equal(f.repository.snapshot.providers.get("personal")!.routing, null);
});
