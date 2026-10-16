import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiKeyPool } from "./api-key-pool-owner.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { createRoutingFeedback } from "./routing-feedback.js";
import type { SharedQuotaInput } from "@lcode/provider";
const input = (id: string, poolId = "team", createdAt = 0): SharedQuotaInput => ({
  providerId: "fixture",
  poolId,
  keyId: id,
  maxInFlight: 8,
  request: {
    attemptId: id,
    scopeKey: "scope",
    modelKey: "model",
    createdAt,
    tokens: { total: 10, quality: "bound" },
  },
  windows: [
    {
      resourceId: "tokens",
      instanceId: "one",
      revision: 1,
      kind: "budget",
      quality: "fresh",
      unit: "tokens",
      remaining: 100,
      limit: 100,
    },
  ],
});
test("HD-04 unknown API 429 blocks other quota pools with structured cooling details", () => {
  const owner = new ApiKeyPool(
    ["a", "b"].map((id) => ({ id, apiKey: "synthetic", routing: { quotaPoolId: id } })),
    undefined,
    undefined,
    undefined,
    () => 0,
  );
  owner.configureRouting({ version: 1, strategy: "primary-backup" });
  const a = owner.reserve({ attemptId: "a", scopeKey: "a" });
  a.begin!();
  a.observe(429, new Headers({ "retry-after-ms": "10000" }));
  a.end!(false);
  a.release();
  assert.throws(
    () => owner.reserve({ attemptId: "b", scopeKey: "b" }),
    (e: unknown) =>
      e instanceof Error &&
      e.message.includes("route-cooling") &&
      (e as Error & { details: { scope: string; retryAt: number } }).details.scope === "provider" &&
      (e as Error & { details: { retryAt: number } }).details.retryAt === 10000,
  );
  owner.dispose();
});
test("HD-04 shared owners enforce provider 429 across different pool files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-harden-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = new FileSharedQuotaCoordinator(directory, { now: () => 0 }),
    b = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const lease = await a.reserve(input("a", "one"));
  await a.dispatch(lease);
  await a.usage(lease, {}, undefined, { outcome: "failed", statusCode: 429, retryAfterMs: 10000 });
  await a.finish(lease);
  await assert.rejects(b.reserve(input("b", "two")), /route-cooling/);
});
test("HD-05 shared owner reclaims healthy recovery records before capacity rejection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-harden-gc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const first = await owner.reserve(input("seed"));
  await owner.cancel(first);
  const path = join(directory, first.poolKey + ".json");
  const state = JSON.parse(await readFile(path, "utf8"));
  for (let i = 0; i < 4100; i++)
    state.recovery["key:" + i] = { revision: 1, retryAt: 0, phase: "healthy" };
  await writeFile(path, JSON.stringify(state));
  const next = await owner.reserve(input("next"));
  await owner.cancel(next);
  assert.ok((await owner.inspect("fixture", "team")).recovery.length < 10);
});
test("HD-06 shared expired zero quota permits one probe and waits for new facts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-harden-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = new FileSharedQuotaCoordinator(directory, { now: () => 11 }),
    b = new FileSharedQuotaCoordinator(directory, { now: () => 11 });
  const stale = (id: string) => ({
    ...input(id, "team", 11),
    windows: [{ ...input(id).windows[0]!, remaining: 0, resetAt: 10 }],
  });
  const probe = await a.reserve(stale("a"));
  await assert.rejects(b.reserve(stale("b")), /reserve-unverifiable|concurrency-full/);
  await a.dispatch(probe);
  await a.finish(probe);
  await a.usage(probe, {}, { total: 5 }, { outcome: "success" });
  await assert.rejects(b.reserve(stale("c")), /reserve-unverifiable|concurrency-full/);
});
test("HD-10 OAuth feedback retries identical payload and exposes terminal failure", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const send = createRoutingFeedback(
    (async (_url, init) => {
      calls++;
      bodies.push(String(init?.body));
      if (calls < 3) throw new Error("offline");
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    "http://fixture.invalid",
    "synthetic",
  );
  await send({ outcome: "success", workUnits: 5 });
  assert.equal(calls, 3);
  assert.equal(new Set(bodies).size, 1);
});

test(
  "HD-04 two real processes cannot bypass a provider-wide cooldown by changing pools",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "routing-provider-process-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const owner = new FileSharedQuotaCoordinator(directory);
    const now = Date.now();
    const first = await owner.reserve(input("failed", "one", now));
    await owner.dispatch(first);
    await owner.usage(first, {}, undefined, {
      outcome: "failed",
      statusCode: 429,
      retryAfterMs: 10000,
    });
    await owner.finish(first);
    const { execFile } = await import("node:child_process"),
      { promisify } = await import("node:util"),
      { fileURLToPath } = await import("node:url");
    const worker = fileURLToPath(new URL("./api-key-shared-quota.fixture.ts", import.meta.url));
    const results = await Promise.all(
      ["two", "three"].map(async (pool) => {
        const result = await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            worker,
            directory,
            "dispatch",
            JSON.stringify(input(pool, pool, Date.now())),
          ],
          { windowsHide: true, timeout: 15000 },
        );
        return JSON.parse(result.stdout);
      }),
    );
    assert.ok(results.every((r) => r.ok === false && r.code === "route-cooling"));
  },
);
test("HD-03 file feedback replay cannot extend a provider deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-retry-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 0;
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => now });
  const a = await owner.reserve(input("a", "one")),
    b = await owner.reserve(input("b", "two"));
  await owner.dispatch(a);
  await owner.dispatch(b);
  await owner.usage(a, {}, undefined, { statusCode: 429, retryAfterMs: 1000 });
  await owner.usage(b, {}, undefined, { statusCode: 429, retryAfterMs: 10000 });
  now = 20000;
  await owner.usage(b, {}, undefined, { statusCode: 429, retryAfterMs: 10000 });
  assert.equal(
    (await owner.inspect("fixture", "one")).recovery.find((r) => r.resource === "provider")!
      .retryAt,
    10000,
  );
});

test("HD-10 permanently unavailable OAuth feedback remains visibly unconfirmed after three attempts", async () => {
  const send = createRoutingFeedback(
    (async () => new Response(null, { status: 503 })) as typeof fetch,
    "http://fixture.invalid",
    "synthetic",
  );
  await send({ outcome: "success" });
  assert.deepEqual(send.diagnostics(), { pending: false, attempts: 3, delivered: false });
});

test("HD-07 API uses declared response cache facts and ignores obsolete manual cache TTL", () => {
  let now = 0;
  const pool = new ApiKeyPool(
    [{ id: "a", apiKey: "synthetic", routing: { cacheGroupId: "old", cacheTtlMs: 86400000 } }],
    undefined,
    undefined,
    undefined,
    () => now,
  );
  pool.configureRouting({ version: 1, strategy: "headroom-balance" });
  assert.equal(pool.readRoutingDiagnostics().items[0]!.cacheGroupId, undefined);
  const lease = pool.reserve({ scopeKey: "s", attemptId: "a" });
  lease.begin!();
  lease.observe(
    200,
    new Headers({
      "x-lcode-cache-ttl-ms": "1000",
      "x-lcode-cache-group": "verified",
      "x-lcode-cache-switch-cost": "10",
      "x-lcode-cache-switch-unit": "tokens",
    }),
  );
  lease.observeUsage!({ outcome: "success", tokens: { total: 5 } });
  lease.end!(true);
  lease.release();
  const row = pool.readRoutingDiagnostics().items[0]!;
  assert.equal(row.cacheGroupId, "verified");
  assert.equal(row.cacheFacts!.source, "upstream-contract");
  assert.equal(row.cacheFacts!.validUntil, 1000);
  now = 1001;
  assert.equal(pool.readRoutingDiagnostics().items[0]!.cacheGroupId, undefined);
  pool.dispose();
});

test("HD-04 provider cooldown survives a downstream pool feedback storage failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-gate-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const lease = await owner.reserve(input("a", "one"));
  await owner.dispatch(lease);
  const failing = owner as unknown as { mutate: (...args: unknown[]) => Promise<unknown> };
  const mutate = failing.mutate;
  failing.mutate = async () => {
    throw new (await import("@lcode/provider")).RoutingError("quota-owner-unavailable");
  };
  await assert.rejects(
    owner.usage(lease, {}, undefined, { statusCode: 429, retryAfterMs: 10000, outcome: "failed" }),
    /quota-owner-unavailable/,
  );
  failing.mutate = mutate;
  const other = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  await assert.rejects(other.reserve(input("b", "two")), /route-cooling/);
});

test("HD-04 stripping the provider handle cannot bypass a later provider cooldown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-gate-fence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const pending = await owner.reserve(input("pending", "two"));
  const failed = await owner.reserve(input("failed", "one"));
  await owner.dispatch(failed);
  await owner.usage(failed, {}, undefined, { statusCode: 429, retryAfterMs: 10000 });
  const { provider: _provider, ...stripped } = pending;
  await assert.rejects(owner.dispatch(stripped), /owner-stale|route-cooling/);
  await assert.rejects(owner.dispatch(pending), /route-cooling/);
});

test("HD-04 provider and pool handles from different valid reservations cannot be spliced", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-gate-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const first = await owner.reserve(input("a", "one"));
  await owner.dispatch(first);
  const second = await owner.reserve(input("b", "two"));
  await assert.rejects(owner.dispatch({ ...second, provider: first.provider }), /owner-stale/);
  assert.equal(await owner.dispatch(second), true);
});
