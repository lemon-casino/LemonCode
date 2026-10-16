import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireFileLock } from "@lcode/shared/node";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";

const input = (attemptId: string, extra = {}, createdAt = Date.now()) => ({
  providerId: "fixture",
  poolId: "team",
  keyId: attemptId,
  maxInFlight: 2,
  request: {
    createdAt,
    attemptId,
    scopeKey: "scope",
    modelKey: "model",
    tokens: { total: 60, quality: "bound" as const },
  },
  windows: [
    {
      resourceId: "tokens",
      instanceId: "period",
      revision: 1,
      kind: "budget" as const,
      quality: "fresh" as const,
      unit: "tokens",
      remaining: 100,
      limit: 100,
    },
  ],
  ...extra,
});

test(
  "RCD-06 two real processes compete for exactly one shared recovery probe",
  { timeout: 20000 },
  async (t) => {
    const path = await directory(t);
    const owner = new FileSharedQuotaCoordinator(path);
    const initial = await owner.reserve(input("failed"));
    await owner.dispatch(initial);
    await owner.usage(
      initial,
      {},
      { total: 0 },
      { outcome: "failed", statusCode: 429, retryAfterMs: 0, rateLimitScope: "shared" },
    );
    await owner.finish(initial);
    const worker = fileURLToPath(new URL("./api-key-shared-quota.fixture.ts", import.meta.url));
    const run = promisify(execFile);
    const results = await Promise.all(
      ["probe-a", "probe-b"].map(async (id) => {
        const value = input(id);
        value.request.tokens.total = 10;
        const result = await run(
          process.execPath,
          ["--import", "tsx", worker, path, "dispatch", JSON.stringify(value)],
          { windowsHide: true, timeout: 15000 },
        );
        return JSON.parse(result.stdout) as { ok: boolean; code?: string };
      }),
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok)!.code, "route-cooling");
    assert.equal((await owner.inspect("fixture", "team")).recovery[0]!.phase, "probing");
  },
);

test("valid long Key identities and internally scoped window IDs remain supported without storing the Key identity", async (t) => {
  const path = await directory(t),
    owner = new FileSharedQuotaCoordinator(path);
  const value = input("long-id");
  value.keyId = "identifier-".repeat(1000);
  value.windows[0]!.resourceId = "scoped-".repeat(100);
  const handle = await owner.reserve(value);
  await owner.cancel(handle);
  const file = join(path, (await readdir(path)).find((f) => f.endsWith(".json"))!);
  assert.equal((await readFile(file, "utf8")).includes(value.keyId), false);
});

test("a window learned from headers also constrains already dispatched attempts", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t));
  const first = await owner.reserve(input("blind", { windows: [] }));
  await owner.dispatch(first);
  await owner.observe("fixture", "team", input("snapshot").windows);
  await assert.rejects(owner.reserve(input("another")), /quota-exhausted/);
  await owner.usage(first, {}, { total: 30 });
  await owner.finish(first);
  const next = await owner.reserve(input("after-actual"));
  await owner.cancel(next);
});

test("XQP-04 forced process exit does not refund a dispatched reservation after its TTL", async (t) => {
  const path = await directory(t);
  const worker = fileURLToPath(new URL("./api-key-shared-quota.fixture.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", worker, path, "hold", JSON.stringify(input("crash"))],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    child.kill();
  });
  await once(child.stdout!, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  const owner = new FileSharedQuotaCoordinator(path, { now: () => Date.now() + 100_000 });
  assert.equal((await owner.inspect("fixture", "team")).inFlight, 1);
  await assert.rejects(
    owner.reserve(input("after-crash", {}, Date.now() + 100_000)),
    /quota-exhausted/,
  );
});

test("XQP-05 partial Token fields preserve unknown total and do not overwrite known input", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t));
  const base = input("partial");
  const first = await owner.reserve({
    ...base,
    request: { ...base.request, tokens: { input: 40, output: 20, total: 60, quality: "bound" } },
    windows: [...base.windows, { ...base.windows[0]!, resourceId: "input", unit: "input_tokens" }],
  });
  await owner.dispatch(first);
  await owner.usage(first, {}, { input: 10, output: undefined, total: undefined });
  await assert.rejects(owner.usage(first, {}, { total: NaN }), /invalid-usage/);
  await owner.finish(first);
  await assert.rejects(owner.reserve(input("total-unknown")), /quota-exhausted/);
  await owner.usage(first, {}, { input: 0, total: 30 });
  const view = await owner.inspect("fixture", "team");
  assert.equal(view.resources.find((r) => r.resourceId === "input")!.available, 90);
  assert.equal(view.resources.find((r) => r.resourceId === "tokens")!.available, 70);
});

test("global hard reserve lines are checked after other clients' debits", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t));
  const base = input("first");
  const request = {
    ...base,
    request: { ...base.request, tokens: { total: 40, quality: "bound" as const } },
    reserveRules: [{ resourceId: "tokens", mode: "hard" as const, minRemainingPercent: 50 }],
  };
  const first = await owner.reserve(request);
  await assert.rejects(
    owner.reserve({
      ...request,
      keyId: "second",
      request: { ...request.request, attemptId: "second" },
    }),
    /quota-exhausted/,
  );
  assert.equal((await owner.inspect("fixture", "team")).resources[0]!.available, 60);
  await owner.cancel(first);
});

test("dispatch rechecks lowered balance, hard reserve and expired windows after reservation", async (t) => {
  for (const mode of ["balance", "reserve", "expiry"]) {
    let now = Date.now();
    const owner = new FileSharedQuotaCoordinator(await directory(t), { now: () => now });
    const value = input(mode);
    value.request.tokens.total = 40;
    const handle = await owner.reserve({
      ...value,
      ...(mode === "reserve"
        ? {
            reserveRules: [
              { resourceId: "tokens", mode: "hard" as const, minRemainingPercent: 50 },
            ],
          }
        : {}),
    });
    await owner.observe("fixture", "team", [
      {
        ...value.windows[0]!,
        remaining: mode === "balance" ? 20 : 70,
        ...(mode === "expiry" ? { expiresAt: now + 10 } : {}),
      },
    ]);
    if (mode === "expiry") now += 11;
    await assert.rejects(owner.dispatch(handle), /quota-exhausted|reserve-unverifiable/);
    await owner.cancel(handle);
  }
});

test("completed known consumption compacts after the admission horizon without reopening old attempts", async (t) => {
  let now = Date.now();
  const owner = new FileSharedQuotaCoordinator(await directory(t), {
    maxLeases: 2,
    now: () => now,
  });
  const payload = (id: string) => {
    const value = input(id);
    return { ...value, request: { ...value.request, createdAt: now } };
  };
  const original = payload("one");
  for (const value of [original, payload("two")]) {
    const handle = await owner.reserve(value);
    await owner.dispatch(handle);
    await owner.usage(handle, {}, { total: 1 });
    await owner.finish(handle);
  }
  now += 30_001;
  const next = await owner.reserve(payload("three"));
  await owner.cancel(next);
  const view = await owner.inspect("fixture", "team");
  assert.equal(view.retainedAttempts, 1);
  assert.equal(view.resources[0]!.available, 98);
  await owner.observe("fixture", "team", [{ ...original.windows[0]!, resourceId: "long-tokens" }]);
  assert.equal(
    (await owner.inspect("fixture", "team")).resources.find((r) => r.resourceId === "long-tokens")!
      .available,
    98,
  );
  await assert.rejects(owner.reserve(original), /attempt-expired/);
  await owner.observe("fixture", "team", original.windows, 1);
  assert.equal((await owner.inspect("fixture", "team")).resources[0]!.available, 98);
  await owner.observe("fixture", "team", original.windows, 2);
  assert.equal((await owner.inspect("fixture", "team")).resources[0]!.available, 100);
});

test("late normalized usage survives a long requests-only body and compacted blind units remain conservative", async (t) => {
  let now = Date.now();
  const owner = new FileSharedQuotaCoordinator(await directory(t), {
    maxLeases: 2,
    now: () => now,
  });
  const value = input("long");
  value.windows[0]!.unit = "requests";
  const first = await owner.reserve(value);
  await owner.dispatch(first);
  now += 30_001;
  await owner.finish(first);
  await owner.usage(first, {}, { total: 15, input: 10, output: 5 });
  const before = await owner.inspect("fixture", "team");
  assert.equal(before.retainedAttempts, 0);
  await owner.observe("fixture", "team", [
    { ...input("snapshot").windows[0]!, resourceId: "new-tokens" },
  ]);
  const after = await owner.inspect("fixture", "team");
  assert.equal(after.resources.find((r) => r.resourceId === "new-tokens")!.available, 85);
});

test("a covered old fixed period cannot replace the current fixed period", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t), { now: () => 100 });
  const old = { ...input("old", {}, 100).windows[0]!, resetAt: 200, resetMode: "fixed" as const };
  const first = await owner.reserve(input("first", { windows: [old] }, 100));
  await owner.dispatch(first);
  await owner.usage(first, {}, { total: 30 });
  await owner.finish(first);
  await owner.observe("fixture", "team", [{ ...old, instanceId: "new-period", resetAt: 300 }]);
  await owner.observe("fixture", "team", [{ ...old, remaining: 0 }], first.sequence);
  const next = await owner.reserve(input("new", { windows: [] }, 100));
  await owner.cancel(next);
});

test("XQP-07 a live file lock times out without stealing the owner or changing its ledger", async (t) => {
  const path = await directory(t);
  const owner = new FileSharedQuotaCoordinator(path, { lockMaxWaitMs: 10 });
  const first = await owner.reserve(input("first"));
  await owner.cancel(first);
  const file = join(path, (await readdir(path)).find((f) => f.endsWith(".json"))!);
  const original = await readFile(file, "utf8");
  const release = await acquireFileLock(file, [1], 100, 100);
  try {
    await assert.rejects(owner.reserve(input("blocked")), /quota-owner-unavailable/);
  } finally {
    await release();
  }
  assert.equal(await readFile(file, "utf8"), original);
});
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "lcode-shared-quota-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("XQP-01 real processes cannot oversubscribe a shared pool and reopening retains debits", async (t) => {
  const path = await directory(t);
  const run = promisify(execFile);
  const worker = fileURLToPath(new URL("./api-key-shared-quota.fixture.ts", import.meta.url));
  const results = await Promise.all(
    ["a", "b"].map(async (id) => {
      const result = await run(
        process.execPath,
        ["--import", "tsx", worker, path, "dispatch", JSON.stringify(input(id))],
        { windowsHide: true },
      );
      return JSON.parse(result.stdout) as { ok: boolean; code?: string };
    }),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok)!.code, "quota-exhausted");
  const reopened = new FileSharedQuotaCoordinator(path);
  await assert.rejects(reopened.reserve(input("after-restart")), /quota-exhausted/);
  assert.equal((await reopened.inspect("fixture", "team")).inFlight, 1);
});

test("XQP-02 every window is atomic and failed reserve does not create a partial debit", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t));
  const request = input("too-large");
  await assert.rejects(
    owner.reserve({
      ...request,
      windows: [...request.windows, { ...request.windows[0]!, resourceId: "short", remaining: 0 }],
    }),
    /quota-exhausted/,
  );
  const view = await owner.inspect("fixture", "team");
  assert.equal(view.inFlight, 0);
  assert.equal(view.reservations, 0);
  const lease = await owner.reserve(input("valid"));
  await owner.cancel(lease);
});

test("an empty or incomplete client snapshot cannot omit the owner long window", async (t) => {
  const path = await directory(t);
  const owner = new FileSharedQuotaCoordinator(path);
  const first = await owner.reserve(input("first"));
  await owner.dispatch(first);
  const another = new FileSharedQuotaCoordinator(path);
  await assert.rejects(another.reserve(input("empty", { windows: [] })), /quota-exhausted/);
});

test("XQP-03 unsent expiry refunds once, fences reject mutations and dispatch is single-use", async (t) => {
  let now = 100;
  const owner = new FileSharedQuotaCoordinator(await directory(t), { now: () => now });
  const first = await owner.reserve(input("first", {}, now));
  assert.deepEqual(await owner.reserve(input("first", {}, now)), first);
  await assert.rejects(owner.dispatch({ ...first, fence: "wrong" }), /owner-stale/);
  now += 30_001;
  await assert.rejects(owner.dispatch(first), /attempt-expired/);
  const next = await owner.reserve(input("next", {}, now));
  assert.equal(await owner.dispatch(next), true);
  assert.equal(await owner.dispatch(next), false);
  await owner.cancel(next);
  now += 100_000;
  await assert.rejects(owner.reserve(input("still-held", {}, now)), /quota-exhausted/);
});

test("XQP-05 actual before/after physical end is per-resource idempotent", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t));
  const first = await owner.reserve(input("first"));
  await owner.dispatch(first);
  await owner.usage(first, { tokens: 30 });
  await assert.rejects(owner.reserve(input("before-end")), /quota-exhausted/);
  await owner.finish(first);
  await owner.usage(first, { tokens: 0 });
  const next = await owner.reserve(input("after-end"));
  await owner.cancel(next);
  assert.equal((await owner.inspect("fixture", "team")).resources[0]!.available, 70);
});

test("XQP-06 snapshots cannot wash debits; explicit global coverage retires only ended consumption", async (t) => {
  const owner = new FileSharedQuotaCoordinator(await directory(t));
  const first = await owner.reserve(input("first"));
  await owner.dispatch(first);
  await owner.observe("fixture", "team", input("unused").windows, first.sequence);
  await assert.rejects(owner.reserve(input("active")), /quota-exhausted/);
  await owner.finish(first);
  await owner.observe("fixture", "team", input("unused").windows, first.sequence);
  const next = await owner.reserve(input("after-cover"));
  await owner.cancel(next);
});

test("XQP-07 corrupt and unknown records fail closed; bounded capacity never silently resets", async (t) => {
  const path = await directory(t);
  const owner = new FileSharedQuotaCoordinator(path, { maxLeases: 1 });
  const first = await owner.reserve(input("first"));
  await owner.cancel(first);
  await assert.rejects(owner.reserve(input("second")), /quota-owner-capacity/);
  const files = (await readdir(path)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const file = join(path, files[0]!);
  const original = await readFile(file, "utf8");
  await writeFile(file, "{invalid");
  await assert.rejects(owner.reserve(input("corrupt")), /quota-owner-unavailable/);
  assert.equal(await readFile(file, "utf8"), "{invalid");
  const changed = { ...JSON.parse(original), schemaVersion: 99 };
  await writeFile(file, JSON.stringify(changed));
  await assert.rejects(owner.reserve(input("unknown-version")), /quota-owner-unavailable/);
});
