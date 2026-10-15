import assert from "node:assert/strict";
import test from "node:test";
import { NativeAccountRefresh } from "./account-refresh.js";
import { defaultLocalIO } from "./local-io.js";
import type { AuthDriverContext, AuthGrant } from "../driver.js";

function owner(
  exchange: (grant: AuthGrant, signal: AbortSignal) => Promise<AuthGrant>,
  lifetime = new AbortController(),
) {
  return new NativeAccountRefresh({
    lifetime: lifetime.signal,
    localIO: defaultLocalIO,
    isFresh: () => false,
    missingRefreshMessage: "fixture refresh missing",
    exchange,
  });
}

test("unbound import candidates never share a refresh flight", async () => {
  const seen: unknown[] = [];
  const refresh = owner(async (grant) => {
    seen.push(grant.refresh);
    return { ...grant, access: String(grant.refresh) };
  });
  const grants = await Promise.all(
    ["first", "second"].map((value) =>
      refresh.fresh({
        read: async () => ({ type: "oauth", refresh: value }),
        write: async () => {},
      }),
    ),
  );
  assert.deepEqual(seen.sort(), ["first", "second"]);
  assert.deepEqual(
    grants.map((grant) => grant.access),
    ["first", "second"],
  );
});

test("a fixed commit without completion ownership does not detach ordinary caller cancellation", async () => {
  const entered = Promise.withResolvers<void>(),
    caller = new AbortController();
  let writes = 0;
  const refresh = owner(async (_grant, signal) => {
    entered.resolve();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });
  const pending = refresh.fresh({
    read: async () => ({ type: "oauth", refresh: "fixture" }),
    write: async () => {
      writes++;
    },
    captureRefreshCommit: () => async () => {
      writes++;
    },
    signal: caller.signal,
  });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  caller.abort();
  await rejected;
  await refresh.drain();
  assert.equal(writes, 0);
});

test("failed completion admission stops rotation before token exchange", async () => {
  let sends = 0;
  const refresh = owner(async () => {
    sends++;
    return { type: "oauth" };
  });
  const context: AuthDriverContext = {
    read: async () => ({ type: "oauth", refresh: "fixture" }),
    write: async () => {},
    captureRefreshCommit: () => async () => {},
    retainRefreshCompletion: () => {
      throw new Error("fixture lock missing");
    },
  };
  await assert.rejects(refresh.fresh(context), /fixture lock missing/);
  await refresh.drain();
  assert.equal(sends, 0);
});

test("driver shutdown during an asynchronous credential read prevents late exchange", async () => {
  const lifetime = new AbortController();
  let sends = 0;
  const refresh = owner(async () => {
    sends++;
    return { type: "oauth" };
  }, lifetime);
  await assert.rejects(
    refresh.fresh({
      read: async () => {
        lifetime.abort();
        return { type: "oauth", refresh: "fixture" };
      },
      write: async () => {},
    }),
    { name: "AbortError" },
  );
  assert.equal(sends, 0);
});
