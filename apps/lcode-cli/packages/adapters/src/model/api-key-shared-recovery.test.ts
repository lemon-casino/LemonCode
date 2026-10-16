import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { ApiKeySharedQuotaClient } from "./api-key-shared-client.js";
import { RoutingError, type SharedQuotaInput, type SharedQuotaCoordinator } from "@lcode/provider";
import type { ApiKeyLease } from "./api-key-lease.js";
import { withApiKeyLease } from "./api-key-fetch.js";

const input = (id: string, createdAt: number): SharedQuotaInput => ({
  providerId: "fixture",
  poolId: "team",
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
      remaining: 100,
      limit: 100,
      unit: "tokens",
    },
  ],
});

test("RCD-06 independent shared owners coordinate a probe and preserve unknown dispatched state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 0;
  const a = new FileSharedQuotaCoordinator(directory, { now: () => now }),
    b = new FileSharedQuotaCoordinator(directory, { now: () => now });
  const first = await a.reserve(input("failed", now));
  await a.dispatch(first);
  await a.usage(first, {}, undefined, {
    outcome: "failed",
    statusCode: 429,
    retryAfterMs: 100,
    rateLimitScope: "shared",
  });
  await a.finish(first);
  now = 100;
  const probe = await a.reserve(input("probe", now));
  await assert.rejects(b.reserve(input("competing", now)), /route-cooling/);
  await a.dispatch(probe);
  await a.finish(probe);
  await a.usage(probe, {}, { total: 5 });
  now = 100000;
  await assert.rejects(b.reserve(input("after-body", now)), /route-cooling/);
  const view = await b.inspect("fixture", "team");
  assert.equal(view.recovery[0]!.phase, "uncertain");
  await a.usage(probe, {}, { total: 5 }, { outcome: "success" });
  const next = await b.reserve(input("recovered", now));
  await b.cancel(next);
});

test("RCD-11 legacy v1 shared records migrate without erasing in-flight debits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const first = await owner.reserve(input("first", 0));
  await owner.dispatch(first);
  const path = join(
    directory,
    (await readdir(directory)).find((p) => p.endsWith(".json") && !p.endsWith(".provider.json"))!,
  );
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.schemaVersion = 1;
  delete saved.recovery;
  for (const lease of Object.values(saved.leases) as Record<string, unknown>[])
    delete lease.recoveryPermit;
  await writeFile(path, JSON.stringify(saved));
  const reopened = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  assert.equal((await reopened.inspect("fixture", "team")).resources[0]!.available, 90);
  const second = await reopened.reserve(input("second", 0));
  await reopened.cancel(second);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(migrated.schemaVersion, 3);
  assert.equal((await reopened.inspect("fixture", "team")).resources[0]!.available, 90);
});

test("RCD-07 a lost dispatch acknowledgement is not retried or reported as TLS and never sends HTTP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-lost-ack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory, { now: () => 0 });
  const dispatch = owner.dispatch.bind(owner);
  let dispatches = 0,
    posts = 0;
  owner.dispatch = async (handle) => {
    dispatches++;
    await dispatch(handle);
    throw new RoutingError("quota-owner-unavailable");
  };
  const client = new ApiKeySharedQuotaClient(owner);
  const lease = await client.prepare("fixture", {
    key: { id: "a", apiKey: "synthetic" },
    sharedQuotaInput: input("a", 0),
    observe() {},
    release() {},
  } as unknown as ApiKeyLease);
  const fetch = withApiKeyLease(
    (async () => {
      posts++;
      return new Response("unexpected");
    }) as typeof globalThis.fetch,
    lease,
    "openai-compatible",
  );
  await assert.rejects(
    fetch("https://fixture.invalid"),
    (error: unknown) =>
      error instanceof RoutingError &&
      error.code === "dispatch-uncertain" &&
      error.retryable === false,
  );
  lease.release();
  await lease.flushRouting!();
  await client.drain();
  assert.equal(dispatches, 1);
  assert.equal(posts, 0);
  assert.equal((await owner.inspect("fixture", "team")).inFlight, 1);
});

test("RCD-08 idempotent feedback retries recover without poisoning drain or replaying dispatch", async () => {
  let observations = 0,
    finishes = 0,
    dispatches = 0;
  const coordinator = {
    reserve: async () => ({ poolKey: "p", leaseId: "l", fence: "f", sequence: 1, expiresAt: 100 }),
    dispatch: async () => {
      dispatches++;
      return true;
    },
    cancel: async () => {},
    rollbackDispatch: async () => {},
    observe: async () => {
      if (++observations === 1) throw new RoutingError("quota-owner-unavailable");
    },
    finish: async () => {
      finishes++;
    },
    usage: async () => {},
    inspect: async () => ({}),
  } as unknown as SharedQuotaCoordinator;
  const client = new ApiKeySharedQuotaClient(coordinator);
  const original = {
    key: { id: "a", apiKey: "synthetic" },
    sharedQuotaInput: input("a", 0),
    observe() {},
    release() {},
    begin: () => true,
    end() {},
  } as unknown as ApiKeyLease;
  const lease = await client.prepare("fixture", original);
  await lease.admit!();
  lease.observe(200, new Headers());
  lease.end!(true);
  await lease.flushRouting!();
  await client.drain();
  assert.equal(observations, 2);
  assert.equal(finishes, 1);
  assert.equal(dispatches, 1);
});

test("RCD-08 permanent feedback errors are bounded and diagnostics never expose raw IO details", async () => {
  let broken = true;
  const coordinator = {
    reserve: async (value: SharedQuotaInput) => ({
      poolKey: "p",
      leaseId: value.keyId,
      fence: "f",
      sequence: 1,
      expiresAt: 100,
    }),
    dispatch: async () => true,
    cancel: async () => {},
    rollbackDispatch: async () => {},
    observe: async () => {
      if (broken)
        throw new RoutingError("quota-owner-unavailable", {
          cause: new Error("synthetic-secret-private-path"),
        });
    },
    finish: async () => {},
    usage: async () => {},
  } as unknown as SharedQuotaCoordinator;
  const client = new ApiKeySharedQuotaClient(coordinator);
  for (let index = 0; index < 300; index++) {
    const lease = await client.prepare("fixture", {
      key: { id: String(index), apiKey: "synthetic" },
      sharedQuotaInput: input(String(index), 0),
      observe() {},
      release() {},
    } as unknown as ApiKeyLease);
    lease.observe(200, new Headers());
  }
  await assert.rejects(client.drain(), /quota-owner-unavailable/);
  const view = client.diagnostics();
  assert.equal(view.failedLeases, 256);
  assert.equal(view.overflowed, true);
  assert.equal(JSON.stringify(view).includes("synthetic-secret"), false);
  broken = false;
  await assert.rejects(client.drain(), /quota-owner-capacity/);
  assert.equal(client.diagnostics().failedLeases, 0);
});
