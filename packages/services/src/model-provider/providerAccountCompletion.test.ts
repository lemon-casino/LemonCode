import assert from "node:assert/strict";
import test from "node:test";
import {
  completeProviderAccountAuthorization,
  type AccountAuthorizationAttempt,
} from "./providerAccountCompletion.js";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

test("cancelling an import cannot remove a connection another Host reauthorized after persistence", async () => {
  const accounts: StoredAccount[] = [];
  const attempt: AccountAuthorizationAttempt = {
    view: {
      attemptId: "fixture",
      channelId: "fixture",
      methodId: "import",
      status: "pending",
      method: "auto",
    },
    controller: new AbortController(),
    driver: {
      methods: async () => [],
      authorize: async () => {
        throw new Error("unused");
      },
      models: async () => [],
      fetch: async () => new Response(),
    },
    challenge: {
      method: "auto",
      complete: async () => ({ type: "oauth", access: "first", identityKey: "user" }),
    },
  };
  await completeProviderAccountAuthorization(
    {
      closed: () => false,
      channel: () => ({ id: "fixture", name: "Fixture" }),
      mutate: async (update) => {
        update(accounts);
        // 模拟当前save已落盘、其await未返回时，另一Host完成同一账号的有效重新授权。
        accounts[0]!.generation++;
        accounts[0]!.grant = { type: "oauth", access: "second", identityKey: "user" };
        attempt.controller.abort();
      },
      rollback: async (update) => {
        update(accounts);
      },
      resetDriver: async () => {},
      useDriver: () => {},
      refreshEnabled: async () => {
        assert.fail("Cancelled import must not refresh models");
      },
      publish: async () => {},
    },
    attempt,
  );
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.grant.access, "second");
});
