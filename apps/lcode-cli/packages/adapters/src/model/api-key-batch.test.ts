import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";

const key = (id: string, pool?: string) => ({
  id,
  apiKey: `synthetic-${id}`,
  routing: pool ? { quotaPoolId: pool } : undefined,
});
const tokens = (attemptId: string, input = 40, output = 20) => ({
  attemptId,
  scopeKey: "scope",
  turnId: attemptId,
  tokens: { input, output, total: input + output, quality: "bound" as const },
  workUnits: input + output,
});
const window = (id = "tokens", remaining = 100, extra = {}) => ({
  resourceId: id,
  instanceId: "period",
  revision: 1,
  kind: "budget" as const,
  quality: "fresh" as const,
  unit: "tokens",
  remaining,
  limit: 100,
  stableId: true,
  ...extra,
});

function fixture(pool = false) {
  const registry = new ApiKeyPoolRegistry();
  const keys = [key("a", pool ? "team" : undefined), key("b", pool ? "team" : undefined)];
  const owner = registry.get("fixture", "generation", keys, {
    version: 1,
    strategy: "primary-backup",
    maxInFlightPerCandidate: 8,
  });
  return { registry, keys, owner };
}

test("strategy disable and re-enable retains shared debits and fences unsent leases", () => {
  const { registry, keys, owner } = fixture(true);
  owner.observeRoutingQuota({ poolId: "team", windows: [window()] });
  const first = owner.reserve(tokens("running"));
  first.begin!();
  const pending = owner.reserve(tokens("pending", 10, 10));
  registry.get("fixture", "generation", keys, null);
  assert.equal(owner.routingEnabled, false);
  assert.throws(() => pending.begin!(), /policy-conflict/);
  pending.release();
  registry.get("fixture", "generation", keys, { version: 1, strategy: "primary-backup" });
  assert.throws(() => owner.reserve(tokens("blocked")), /quota-exhausted/);
  first.end!(true);
  first.release();
  first.observeUsage!({ outcome: "success", tokens: { total: 30 }, workUnits: 30 });
  const next = owner.reserve(tokens("after-usage"));
  next.release();
  registry.dispose();
});

test("AKB-001 Token demand prevents concurrent oversubscription and unsent cancel refunds it", () => {
  const { registry, owner } = fixture();
  owner.observeRoutingQuota({ keyId: "a", windows: [window()] });
  owner.observeRoutingQuota({ keyId: "b", windows: [window("tokens", 0)] });
  const first = owner.reserve(tokens("one"));
  assert.throws(() => owner.reserve(tokens("two")), /quota-exhausted/);
  first.release();
  const next = owner.reserve(tokens("three"));
  assert.equal(next.key.id, "a");
  next.release();
  registry.dispose();
});

test("AKB-002 alternate Keys cannot bypass one shared Token pool", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({ poolId: "team", windows: [window()] });
  const first = owner.reserve(tokens("one"));
  first.begin!();
  assert.throws(() => owner.reserve(tokens("two")), /quota-exhausted/);
  first.end!(true);
  first.release();
  first.observeUsage!({
    outcome: "success",
    workUnits: 30,
    tokens: { input: 20, output: 10, total: 30 },
  });
  first.observeUsage!({
    outcome: "success",
    workUnits: 0,
    tokens: { input: 0, output: 0, total: 0 },
  });
  const next = owner.reserve(tokens("three"));
  assert.throws(() => owner.reserve(tokens("four", 10, 10)), /quota-exhausted/);
  next.release();
  registry.dispose();
});

test("AKB-003 short/long and request/Token constraints commit all or nothing", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({
    poolId: "team",
    windows: [
      window("weekly", 100),
      window("short", 10),
      window("requests", 10, { unit: "requests", limit: 10 }),
    ],
  });
  assert.throws(() => owner.reserve(tokens("reject")), /quota-exhausted/);
  const small = owner.reserve(tokens("small", 5, 5));
  small.release();
  registry.dispose();
});

for (const late of [false, true])
  test(`AKB-004 usage ${late ? "after" : "before"} physical completion is idempotent`, () => {
    const { registry, owner } = fixture(true);
    owner.observeRoutingQuota({ poolId: "team", windows: [window()] });
    const first = owner.reserve(tokens("one"));
    first.begin!();
    if (late) first.end!(true);
    first.observeUsage!({
      outcome: "success",
      workUnits: 30,
      tokens: { input: 20, output: 10, total: 30 },
    });
    first.end!(true);
    first.release();
    const next = owner.reserve(tokens("two", 40, 30));
    assert.throws(() => owner.reserve(tokens("three", 1, 0)), /quota-exhausted/);
    next.release();
    registry.dispose();
  });

test("AKB-005 partial actual usage cannot release unknown total demand", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({ poolId: "team", windows: [window()] });
  const first = owner.reserve(tokens("one"));
  first.begin!();
  first.observeUsage!({ outcome: "success", tokens: { input: 10 } });
  first.end!(true);
  first.release();
  assert.throws(() => owner.reserve(tokens("two")), /quota-exhausted/);
  registry.dispose();
});

test("AKB-006 newer snapshot without coverage does not erase shared local debits", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({ poolId: "team", windows: [window()] });
  const first = owner.reserve(tokens("one"));
  first.begin!();
  first.end!(true);
  first.release();
  owner.observeRoutingQuota({ poolId: "team", windows: [window("tokens", 100, { revision: 2 })] });
  assert.throws(() => owner.reserve(tokens("two")), /quota-exhausted/);
  owner.observeRoutingQuota({
    poolId: "team",
    windows: [window("tokens", 100, { revision: 3, coversThroughSeq: 1 })],
  });
  const next = owner.reserve(tokens("three"));
  next.release();
  registry.dispose();
});

test("partial usage can later fill a different resource without overwriting already accepted usage", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({
    poolId: "team",
    windows: [window(), window("input", 100, { unit: "input_tokens" })],
  });
  const first = owner.reserve(tokens("one"));
  first.begin!();
  first.observeUsage!({ tokens: { input: 10 } });
  first.end!(true);
  first.release();
  first.observeUsage!({ tokens: { input: 0, output: 20, total: 30 }, workUnits: 30 });
  const second = owner.reserve(tokens("two", 60, 10));
  second.release();
  registry.dispose();
});

test("private windows remain constraints alongside a declared shared pool", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({ poolId: "team", windows: [window()] });
  owner.observeRoutingQuota({ keyId: "a", windows: [window("private", 0)] });
  const selected = owner.reserve(tokens("one"));
  assert.equal(selected.key.id, "b");
  selected.release();
  registry.dispose();
});

test("equal or older quota revisions cannot replace an exhausted shared reading", () => {
  const { registry, owner } = fixture(true);
  owner.observeRoutingQuota({ poolId: "team", windows: [window("tokens", 0, { revision: 2 })] });
  assert.throws(() => owner.reserve(tokens("exhausted")), /quota-exhausted/);
  for (const revision of [1, 2]) {
    owner.observeRoutingQuota({ poolId: "team", windows: [window("tokens", 100, { revision })] });
    assert.throws(() => owner.reserve(tokens(`stale-${revision}`)), /quota-exhausted/);
  }
  owner.observeRoutingQuota({ poolId: "team", windows: [window("tokens", 100, { revision: 3 })] });
  const next = owner.reserve(tokens("fresh"));
  next.release();
  registry.dispose();
});

test("AKB-007 metadata updates retain auth isolation and invalidate unsent routing leases", () => {
  const { registry, keys, owner } = fixture();
  const rejected = owner.reserve(tokens("old"));
  rejected.observe(401);
  rejected.release();
  const pending = owner.reserve(tokens("pending"));
  const updated = registry.get(
    "fixture",
    "generation",
    keys.map((key) => ({ ...key, routing: { quotaPoolId: "new-team" } })),
    { version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 },
  );
  assert.equal(updated, owner);
  assert.throws(() => pending.begin!(), /policy-conflict/);
  pending.release();
  const next = owner.reserve(tokens("next"));
  assert.equal(next.key.id, "b");
  next.release();
  registry.dispose();
});

test("late headers after regrouping update the original pool, never the new group", () => {
  const { registry, keys, owner } = fixture(true);
  const first = owner.reserve(tokens("old"));
  first.begin!();
  registry.get(
    "fixture",
    "generation",
    keys.map((key) => ({ ...key, routing: { quotaPoolId: "new-team" } })),
    { version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 },
  );
  owner.observeRoutingQuota({ poolId: "new-team", windows: [window()] });
  first.observe(
    200,
    new Headers({ "x-ratelimit-limit-tokens": "100", "x-ratelimit-remaining-tokens": "0" }),
  );
  first.end!(true);
  first.release();
  const next = owner.reserve(tokens("next"));
  next.release();
  registry.dispose();
});

test("AKB-012 paginated diagnostics are redacted, readonly and reject stale revisions", () => {
  const { registry, owner } = fixture();
  const warm = owner.reserve(tokens("warm"));
  warm.release();
  const first = owner.readRoutingDiagnostics({ limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.source, "executor-preview");
  assert.equal(first.items[0]!.inFlight, 0);
  assert.equal(first.nextOffset, 1);
  assert.equal(JSON.stringify(first).includes("synthetic-"), false);
  for (let i = 0; i < 10; i++)
    assert.equal(owner.readRoutingDiagnostics({ limit: 1 }).revision, first.revision);
  const next = owner.readRoutingDiagnostics({
    offset: first.nextOffset,
    limit: 1,
    revision: first.revision,
  });
  assert.equal(next.items[0]!.keyId, "b");
  const lease = owner.reserve(tokens("next"));
  assert.throws(
    () => owner.readRoutingDiagnostics({ revision: first.revision }),
    /policy-conflict/,
  );
  lease.release();
  registry.dispose();
});

test("batch Key priority and shares apply while explicit strategy fields take precedence", () => {
  const registry = new ApiKeyPoolRegistry();
  const keys = [key("a"), key("b")].map((key, i) => ({
    ...key,
    routing: { weight: i ? 3 : 1, priority: i ? 1 : 2 },
  }));
  const primary = registry.get("fixture", "generation", keys, {
    version: 1,
    strategy: "primary-backup",
  });
  const preferred = primary.reserve();
  assert.equal(preferred.key.id, "b");
  preferred.release();
  const overridden = registry.get("fixture", "generation", keys, {
    version: 1,
    strategy: "primary-backup",
    order: ["a"],
  });
  const forced = overridden.reserve();
  assert.equal(forced.key.id, "a");
  forced.release();
  for (const explicit of [false, true]) {
    const pool = registry.get("fixture", "generation", keys, {
      version: 1,
      strategy: "share-rotation",
      ...(explicit ? { weights: { a: 3, b: 1 } } : {}),
    });
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 400; i++) {
      const lease = pool.reserve({
        attemptId: `${explicit}-${i}`,
        scopeKey: "shares",
        workUnits: 4096,
      });
      counts[lease.key.id as "a" | "b"]++;
      lease.begin!();
      lease.end!(true);
      lease.release();
    }
    assert.ok(explicit ? counts.a > counts.b * 2 : counts.b > counts.a * 2);
  }
  registry.dispose();
});
