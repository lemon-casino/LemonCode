import assert from "node:assert/strict";
import test from "node:test";
import { createProviderAccountContext } from "./providerAccountContext.js";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

for (const invalidation of ["none", "deleted", "disabled", "reauthorized", "owner-closed"])
  test(`rotation commit detaches caller but respects ${invalidation} fencing`, async () => {
    const account: StoredAccount = {
      connectionId: "00000000-0000-4000-8000-000000000001",
      channelId: "codex",
      displayName: "fixture",
      enabled: true,
      generation: 1,
      grant: { type: "oauth", refresh: "fixture-old" },
      models: [],
    };
    let accounts = [account];
    const caller = new AbortController();
    let active = true;
    const context = createProviderAccountContext(
      {
        read: async () => accounts,
        mutate: async (update) => {
          update(accounts);
        },
      },
      account,
      caller.signal,
      () => active,
    );
    await context.read();
    const commitRefresh = context.captureRefreshCommit!();
    caller.abort();
    await assert.rejects(context.write({ type: "oauth" }), { name: "AbortError" });
    if (invalidation === "deleted") accounts = [];
    if (invalidation === "disabled") account.enabled = false;
    if (invalidation === "reauthorized") account.generation++;
    if (invalidation === "owner-closed") active = false;
    const commit = commitRefresh({ type: "oauth", refresh: "fixture-new" });
    if (invalidation === "none") {
      await commit;
      assert.equal(account.grant.refresh, "fixture-new");
    } else {
      await assert.rejects(commit, /Stale/);
      assert.equal(account.grant.refresh, "fixture-old");
    }
  });

test("a later read cannot rebase an already captured rotation commit onto a new account generation", async () => {
  const account: StoredAccount = {
    connectionId: "00000000-0000-4000-8000-000000000001",
    channelId: "codex",
    displayName: "fixture",
    enabled: true,
    generation: 1,
    grant: { type: "oauth" },
    models: [],
  };
  const context = createProviderAccountContext(
    {
      read: async () => [account],
      mutate: async (update) => {
        update([account]);
      },
    },
    account,
  );
  await context.read();
  const commit = context.captureRefreshCommit!();
  account.generation++;
  await context.read();
  await assert.rejects(commit({ type: "oauth", refresh: "fixture-stale" }), /Stale/);
});
