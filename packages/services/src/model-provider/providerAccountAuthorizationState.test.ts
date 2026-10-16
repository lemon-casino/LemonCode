import assert from "node:assert/strict";
import test from "node:test";
import {
  completeProviderAccountAuthorization,
  type AccountAuthorizationAttempt,
} from "./providerAccountCompletion.js";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

function fixture(phase: "exchange" | "storage" | "refresh" | "publish" | "cleanup") {
  const accounts: StoredAccount[] = [];
  let disposed = 0,
    handedOff = false;
  const attempt: AccountAuthorizationAttempt = {
    view: {
      attemptId: "fixture",
      channelId: "workbuddy",
      methodId: "0",
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
      dispose: async () => {
        disposed++;
      },
    },
    challenge: {
      method: "auto",
      complete: async () => {
        if (phase === "exchange")
          throw new DOMException("fixture-secret-not-for-logs", "TimeoutError");
        return { type: "oauth", access: "fixture-secret", accountId: "fixture" };
      },
    },
  };
  const host = {
    closed: () => false,
    channel: () => ({ id: "workbuddy", name: "Fixture" }),
    mutate: async (update: (items: StoredAccount[]) => void) => {
      if (phase === "storage") throw new Error("fixture-secret-storage");
      update(accounts);
    },
    rollback: async () => {},
    adoptDriver: async () => {
      handedOff = true;
      if (phase === "cleanup") throw new Error("fixture cleanup");
    },
    refreshEnabled: async () => {
      if (phase === "refresh") throw new Error("fixture refresh");
    },
    publish: async () => {
      if (phase === "publish") throw new Error("fixture publish");
    },
  };
  return { attempt, host, accounts, disposed: () => disposed, handedOff: () => handedOff };
}
for (const phase of ["refresh", "publish", "cleanup"] as const)
  test("PC-04 committed credentials survive post-login " + phase + " failure", async () => {
    const f = fixture(phase);
    await completeProviderAccountAuthorization(f.host, f.attempt);
    assert.equal(f.accounts.length, 1);
    assert.equal(f.attempt.view.status, "completed");
    assert.equal(f.attempt.view.diagnostic?.credentialsSaved, true);
    assert.equal(f.attempt.view.diagnostic?.phase, "post-login");
    assert.equal(
      f.disposed(),
      0,
      "a handed-off account driver must not be disposed by the attempt",
    );
    assert.equal(f.handedOff(), true);
    assert.ok(!JSON.stringify(f.attempt.view).includes("fixture-secret"));
  });
for (const phase of ["exchange", "storage"] as const)
  test("PC-03 safe precommit " + phase + " failure retains its phase", async () => {
    const f = fixture(phase);
    await completeProviderAccountAuthorization(f.host, f.attempt);
    assert.equal(f.attempt.view.status, "failed");
    assert.equal(f.attempt.view.diagnostic?.credentialsSaved, false);
    assert.equal(
      f.attempt.view.diagnostic?.phase,
      phase === "exchange" ? "exchange" : "persisting",
    );
    assert.equal(f.attempt.view.diagnostic?.code, phase === "exchange" ? "timeout" : "storage");
    assert.equal(f.accounts.length, 0);
    assert.equal(f.disposed(), 1);
    assert.ok(!JSON.stringify(f.attempt.view).includes("fixture-secret"));
  });

test("PC-04 completed commit remains observable while post-login is pending", async () => {
  const f = fixture("refresh");
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  f.host.refreshEnabled = async () => {
    entered();
    await done;
    throw new Error("late directory error");
  };
  const pending = completeProviderAccountAuthorization(f.host, f.attempt);
  await started;
  try {
    assert.equal(f.attempt.view.status, "completed");
    assert.equal(f.attempt.view.diagnostic?.followupPending, true);
  } finally {
    release();
    await pending;
  }
  assert.equal(f.attempt.view.diagnostic?.followupPending, false);
  assert.equal(f.attempt.view.diagnostic?.phase, "post-login");
  assert.equal(f.attempt.view.diagnostic?.credentialsSaved, true);
});
test("PC-04 an entirely invalid batch cannot claim saved credentials", async () => {
  const f = fixture("refresh");
  f.attempt.challenge.completeMany = async () => [{ status: "failed", label: "fixture" }];
  await completeProviderAccountAuthorization(f.host, f.attempt);
  assert.equal(f.attempt.view.status, "completed");
  assert.equal(f.attempt.view.diagnostic?.credentialsSaved, false);
  assert.equal(f.accounts.length, 0);
});
