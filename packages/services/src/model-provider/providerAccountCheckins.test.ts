import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAccountCheckins } from "./providerAccountCheckins.js";
import type { StoredAccount } from "./providerAccountStoreSchema.js";
import type { AuthDriver } from "@lcode/provider-node";

function fixture() {
  let now = Date.parse("2026-10-15T12:00:00+08:00"),
    claims = 0,
    release: (() => void) | undefined;
  let account: StoredAccount | undefined = {
    connectionId: "a",
    channelId: "workbuddy",
    displayName: "Fixture",
    enabled: true,
    generation: 1,
    grant: { type: "oauth" },
    models: [],
  };
  const active = new Set<AbortController>();
  const host = {
    read: async () => (account ? [structuredClone(account)] : []),
    mutate: async (fn: (a: StoredAccount[]) => void) => {
      const list = account ? [account] : [];
      fn(list);
      account = list[0];
    },
    driver: async (): Promise<AuthDriver> => ({
      methods: async () => [],
      authorize: async () => {
        throw new Error("unused");
      },
      models: async () => [],
      fetch: async () => new Response(),
      checkin: async () => {
        claims++;
        if (release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { outcome: "claimed", credit: 10 };
      },
    }),
    context: () => ({
      read: async () => ({ type: "oauth" as const }),
      write: async () => {},
      isCurrent: (a: StoredAccount) => a.generation === 1,
    }),
    track: () => {
      const c = new AbortController();
      active.add(c);
      return c;
    },
    untrack: (_id: string, c: AbortController) => {
      active.delete(c);
    },
    withAccountLock: async <T>(_a: StoredAccount, fn: () => Promise<T>) => fn(),
    closed: () => false,
    supportsCheckin: async () => true,
    publish: async () => {},
    activityChanged: () => {},
    invalidateQuota: () => {},
  };
  const owner = new ProviderAccountCheckins(host, { now: () => now });
  return {
    owner,
    host,
    active,
    get account() {
      return account;
    },
    get claims() {
      return claims;
    },
    advance: (ms: number) => {
      now += ms;
    },
    remove: () => {
      account = undefined;
    },
    hold: () => {
      release = () => {};
    },
    unblock: () => release?.(),
  };
}

test("manual and automatic requests share one result, persisted for the Beijing day", async () => {
  const f = fixture();
  await f.owner.run("a");
  await f.owner.run("a");
  assert.equal(f.claims, 1);
  assert.equal(f.account?.checkin?.result?.credit, 10);
  f.advance(24 * 3600_000);
  await f.owner.run("a");
  assert.equal(f.claims, 2);
  assert.equal(f.active.size, 0);
  f.owner.dispose();
});

test("late results cannot recreate a removed account", async () => {
  const f = fixture();
  f.hold();
  const work = f.owner.run("a");
  while (!f.claims) await new Promise((r) => setImmediate(r));
  f.remove();
  f.unblock();
  await work;
  assert.equal(f.account, undefined);
  assert.equal(f.active.size, 0);
  f.owner.dispose();
});

test("automatic check-in is opt-in, persisted, and skips disabled accounts", async () => {
  const f = fixture();
  await f.owner.runAutomatic();
  assert.equal(f.claims, 0);
  await f.owner.setAutomatic("a", true);
  await f.owner.runAutomatic();
  assert.equal(f.claims, 1);
  assert.equal(f.account?.checkin?.automatic, true);
  f.advance(24 * 3600_000);
  f.account!.enabled = false;
  await f.owner.setAutomatic("a", false);
  await f.owner.setAutomatic("a", true);
  await f.owner.runAutomatic();
  assert.equal(f.claims, 1);
  f.owner.dispose();
});

test("concurrent clicks share one flight and disabled, reauthorized or closed accounts reject late commits", async () => {
  for (const change of ["disabled", "reauthorized", "closed"]) {
    const f = fixture();
    f.hold();
    const first = f.owner.run("a"),
      second = f.owner.run("a");
    while (!f.claims) await new Promise((r) => setImmediate(r));
    assert.equal(f.claims, 1);
    if (change === "disabled") f.account!.enabled = false;
    else if (change === "reauthorized") f.account!.generation++;
    else f.owner.dispose();
    f.unblock();
    await Promise.all([first, second]);
    assert.equal(f.account?.checkin?.result, undefined);
    assert.equal(f.active.size, 0);
    f.owner.dispose();
  }
});

test("automatic timer stops on disposal and failed results respect retry pacing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  await f.owner.setAutomatic("a", true);
  f.owner.start();
  f.owner.dispose();
  t.mock.timers.tick(24 * 3600_000);
  assert.equal(f.claims, 0);
  const g = fixture();
  g.host.driver = async () => ({
    methods: async () => [],
    authorize: async () => {
      throw new Error("unused");
    },
    models: async () => [],
    fetch: async () => new Response(),
    checkin: async () => {
      throw new Error("offline");
    },
  });
  await g.owner.setAutomatic("a", true);
  await g.owner.runAutomatic();
  assert.equal(g.account?.checkin?.result?.outcome, "failed");
  const at = g.account?.checkin?.result?.at;
  g.advance(29 * 60_000);
  await g.owner.runAutomatic();
  assert.equal(g.account?.checkin?.result?.at, at);
  g.advance(2 * 60_000);
  await g.owner.runAutomatic();
  assert.notEqual(g.account?.checkin?.result?.at, at);
  g.owner.dispose();
});

test("cache-only flights advance activity revisions and timeout becomes a visible retryable result", async (t) => {
  const f = fixture();
  let revisions = 0;
  f.host.activityChanged = () => {
    revisions++;
  };
  await f.owner.run("a");
  await f.owner.run("a");
  assert.equal(revisions, 4);
  assert.equal(f.claims, 1);
  f.owner.dispose();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const g = fixture();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  g.host.driver = async () => ({
    methods: async () => [],
    authorize: async () => {
      throw new Error("unused");
    },
    models: async () => [],
    fetch: async () => new Response(),
    checkin: async (context) => {
      entered();
      await new Promise<void>((_r, reject) =>
        context.signal!.addEventListener("abort", () => reject(context.signal!.reason), {
          once: true,
        }),
      );
      return { outcome: "claimed" };
    },
  });
  const work = g.owner.run("a");
  await ready;
  t.mock.timers.tick(30_000);
  await work;
  assert.equal(g.account?.checkin?.result?.outcome, "failed");
  assert.equal(g.active.size, 0);
  g.owner.dispose();
});
