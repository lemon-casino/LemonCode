import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthDriver, AuthDriverContext } from "@lcode/provider-node";
import { ProviderAccountQuotas } from "./providerAccountQuotas.js";
import { createProviderAccountContext } from "./providerAccountContext.js";
import { ProviderAccounts } from "./providerAccounts.js";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(quota?: AuthDriver["quota"], beforeRead?: () => void) {
  let time = Date.parse("2026-10-11T04:00:00Z"),
    closed = false;
  const accounts: StoredAccount[] = ["a", "b"].map((connectionId) => ({
    connectionId,
    channelId: "fixture",
    displayName: connectionId,
    enabled: true,
    generation: 1,
    grant: { type: "oauth", access: `private-${connectionId}` },
    models: [],
  }));
  const store = {
    read: async () => {
      beforeRead?.();
      return structuredClone(accounts);
    },
    mutate: async (update: (rows: StoredAccount[]) => void) => {
      update(accounts);
    },
  };
  const controllers = new Set<AbortController>();
  let fetches = 0,
    locks = 0;
  const driver: AuthDriver = {
    methods: async () => [],
    authorize: async () => {
      throw new Error("unused");
    },
    models: async () => [],
    fetch: async () => {
      fetches++;
      throw new Error("quota must not invoke model inference");
    },
    ...(quota ? { quota } : {}),
  };
  const owner = new ProviderAccountQuotas(
    {
      ...store,
      driver: async () => driver,
      context: (account, signal) => createProviderAccountContext(store, account, signal),
      track: () => {
        const controller = new AbortController();
        controllers.add(controller);
        return controller;
      },
      untrack: (_id, controller) => {
        controllers.delete(controller);
      },
      withAccountLock: async (_account, run) => {
        locks++;
        return run();
      },
      closed: () => closed,
    },
    () => time,
  );
  return {
    owner,
    accounts,
    controllers,
    advance: (ms: number) => {
      time += ms;
    },
    close: () => {
      closed = true;
      owner.dispose();
    },
    counts: () => ({ fetches, locks }),
  };
}

test("routing projection retains known quota across token rotation but rejects a new authorization epoch", async () => {
  const f = fixture(async () => ({
    windows: [{ id: "weekly", name: "Weekly", used: 100, remaining: 0, limit: 100 }],
  }));
  await f.owner.get("a");
  f.accounts[0]!.generation++;
  assert.equal(f.owner.peek("a", f.accounts[0]!.generation, 0)?.value.windows[0]?.remaining, 0);
  f.accounts[0]!.routingEpoch = 1;
  assert.equal(f.owner.peek("a", f.accounts[0]!.generation, 1), undefined);
  f.close();
});

test("coalesces per-account reads, reuses TTL, isolates accounts and force refreshes without inference", async () => {
  const pending = deferred<unknown>(),
    began = deferred<void>();
  let calls = 0;
  const f = fixture(async (context) => {
    calls++;
    await context.read();
    began.resolve();
    return pending.promise;
  });
  const first = f.owner.get("a");
  await began.promise;
  const second = f.owner.get("a", true);
  pending.resolve({ windows: [{ name: "Weekly", used: 30 }] });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(one, two);
  one.windows[0]!.usedPercent = 99;
  assert.equal((await f.owner.get("a")).windows[0]!.usedPercent, 30);
  await f.owner.get("b");
  assert.equal(calls, 2);
  await f.owner.get("a", true);
  assert.equal(calls, 3);
  f.advance(60_001);
  await f.owner.get("a");
  assert.equal(calls, 4);
  assert.deepEqual(f.counts(), { fetches: 0, locks: 4 });
  assert.equal(f.controllers.size, 0);
});

test("failed refresh preserves last successful time/windows and sanitizes errors", async () => {
  let fail = false;
  const f = fixture(async () => {
    if (fail) throw new Error("access_token=private-grant");
    return { windows: [{ name: "Weekly", used: 25 }], plan: "Pro" };
  });
  const success = await f.owner.get("a");
  fail = true;
  f.advance(10_000);
  const failure = await f.owner.get("a", true);
  assert.equal(failure.status, "error");
  assert.equal(failure.stale, true);
  assert.equal(failure.checkedAt, success.checkedAt);
  assert.notEqual(failure.attemptedAt, success.attemptedAt);
  assert.equal(failure.windows[0]!.usedPercent, 25);
  assert.equal(failure.error, "request_failed");
  assert.equal(JSON.stringify(failure).includes("private"), false);
});

test("a failed final local read releases the flight so manual refresh can recover", async () => {
  let reads = 0,
    calls = 0;
  const f = fixture(
    async () => {
      calls++;
      return { windows: [{ name: "Weekly", used: 25 }] };
    },
    () => {
      if (++reads === 4) throw new Error("private local store read failure");
    },
  );
  const failed = await f.owner.get("a");
  assert.equal(failed.error, "request_failed");
  assert.equal(JSON.stringify(failed).includes("private"), false);
  assert.equal(f.controllers.size, 0);
  const recovered = await f.owner.get("a", true);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.windows[0]!.usedPercent, 25);
  assert.equal(calls, 2);
});

test("partial current readings replace old quota and preserve metadata on a later total failure", async () => {
  let stage = 0;
  const f = fixture(async () => {
    if (stage === 2) throw new Error("private");
    return stage === 0
      ? { windows: [{ name: "Weekly", used: 25 }] }
      : {
          error: "one upstream unavailable",
          balance: "$4",
          plan: "Pro",
          until: "2026-11-01T00:00:00Z",
          renew: "auto",
        };
  });
  await f.owner.get("a");
  stage = 1;
  const partial = await f.owner.get("a", true);
  assert.equal(partial.partial, true);
  assert.equal(partial.stale, false);
  assert.equal(partial.balance, "$4");
  assert.equal(partial.windows.length, 0);
  stage = 2;
  const failure = await f.owner.get("a", true);
  assert.equal(failure.stale, true);
  assert.equal(failure.partial, true);
  assert.equal(failure.planExpiresAt, "2026-11-01T00:00:00.000Z");
  assert.equal(failure.renewal, "auto");
});

test("unsupported, unreported, disabled and removed accounts are explicit", async () => {
  const missing = fixture();
  assert.equal((await missing.owner.get("a")).status, "unsupported");
  assert.equal((await missing.owner.get("a")).checkedAt, undefined);
  missing.accounts[0]!.enabled = false;
  assert.equal((await missing.owner.get("a", true)).status, "disabled");
  missing.accounts.splice(0, 1);
  assert.equal((await missing.owner.get("a")).status, "removed");
  assert.equal(missing.counts().locks, 1);
  const empty = fixture(async () => ({ windows: [] }));
  assert.equal((await empty.owner.get("a")).status, "unknown");
  assert.equal((await empty.owner.get("a")).checkedAt, undefined);
});

test("quota credential refresh uses context CAS and accepts only its own new generation", async () => {
  const f = fixture(async (context) => {
    const grant = await context.read();
    await context.write({ ...grant!, access: "private-refreshed" });
    return { windows: [{ name: "Monthly", used: 10 }] };
  });
  assert.equal((await f.owner.get("a")).status, "ready");
  assert.equal(f.accounts[0]!.generation, 2);
  assert.equal((await f.owner.get("a")).status, "ready");
  assert.equal(f.counts().locks, 1);
});

test("external generation changes and account removal reject late readings and grant writes", async () => {
  for (const change of ["generation", "disabled", "removed"] as const) {
    const pending = deferred<unknown>(),
      began = deferred<AuthDriverContext>();
    const f = fixture(async (context) => {
      await context.read();
      began.resolve(context);
      return pending.promise;
    });
    const result = f.owner.get("a");
    const context = await began.promise;
    if (change === "removed") f.accounts.splice(0, 1);
    else {
      f.accounts[0]!.generation++;
      if (change === "disabled") f.accounts[0]!.enabled = false;
    }
    await assert.rejects(context.write({ type: "oauth", access: "private-late" }));
    pending.resolve({ windows: [{ name: "Weekly", used: 10 }] });
    const view = await result;
    assert.equal(view.status, change === "generation" ? "error" : change);
    assert.equal(view.windows.length, 0);
    assert.equal(view.checkedAt, undefined);
  }
});

test("invalidation and disposal release callers even if the old driver ignores abort", async () => {
  const pending = deferred<unknown>(),
    began = deferred<void>();
  const f = fixture(async () => {
    began.resolve();
    return pending.promise;
  });
  const result = f.owner.get("a");
  await began.promise;
  f.close();
  const view = await result;
  assert.equal(view.error, "service_closed");
  pending.resolve({ windows: [{ name: "Old", used: 20 }] });
  assert.equal(f.controllers.size, 0);
});

test("a newer account generation supersedes an in-flight reading without replacing its cache", async () => {
  const pending = deferred<unknown>(),
    began = deferred<void>();
  let calls = 0;
  const f = fixture(async (context) => {
    await context.read();
    if (++calls === 1) {
      began.resolve();
      return pending.promise;
    }
    return { windows: [{ name: "New", used: 70 }] };
  });
  const old = f.owner.get("a");
  await began.promise;
  f.accounts[0]!.generation++;
  const latest = await f.owner.get("a");
  assert.equal(latest.windows[0]!.usedPercent, 70);
  assert.equal((await old).error, "account_changed");
  pending.resolve({ windows: [{ name: "Old", used: 5 }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.owner.get("a")).windows[0]!.usedPercent, 70);
  assert.equal(calls, 2);
});

test("quota timeout returns a bounded error and cannot accept a later credential write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<unknown>(),
    began = deferred<AuthDriverContext>();
  const f = fixture(async (context) => {
    await context.read();
    began.resolve(context);
    return pending.promise;
  });
  const reading = f.owner.get("a");
  const context = await began.promise;
  t.mock.timers.tick(30_000);
  const view = await reading;
  assert.equal(view.error, "request_failed");
  assert.equal(view.checkedAt, undefined);
  await assert.rejects(context.write({ type: "oauth", access: "private-late" }));
  pending.resolve({ windows: [{ name: "Late", used: 1 }] });
  assert.equal(f.controllers.size, 0);
});

test("ProviderAccounts exposes quota through the real account lifecycle and cancels removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-quota-"));
  const stored = new Map<string, string>(),
    pending = deferred<unknown>(),
    began = deferred<void>();
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    channels: [{ id: "fixture", name: "Fixture" }],
    credentials: {
      load: async (key) => stored.get(key) ?? null,
      save: async (key, value) => {
        stored.set(key, value);
      },
      delete: async (key) => {
        stored.delete(key);
      },
    },
    factory: async () => ({
      methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async () => ({ type: "oauth", access: "fixture-only" }),
      }),
      models: async () => [],
      fetch: async () => {
        throw new Error("must not infer");
      },
      quota: async (context) => {
        await context.read();
        began.resolve();
        return pending.promise;
      },
    }),
  });
  try {
    const login = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
    const completed = await service.completeAuthorization(login.attemptId, "fixture");
    const connectionId = completed.connectionId!;
    const quota = service.getQuota(connectionId);
    await began.promise;
    await service.removeAccount(connectionId);
    assert.equal((await quota).status, "removed");
    pending.resolve({ windows: [{ name: "Late", used: 1 }] });
    assert.equal((await service.getQuota(connectionId)).status, "removed");
  } finally {
    pending.resolve({ windows: [] });
    await service.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
