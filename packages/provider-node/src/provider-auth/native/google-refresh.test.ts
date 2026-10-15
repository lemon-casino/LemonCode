import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAuthDriver } from "./google.js";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { setImmediate } from "node:timers/promises";

for (const channel of ["gemini", "antigravity"] as const)
  test(`${channel} retains one authorized rotation after caller cancellation without continuing that caller`, async () => {
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    let grant: AuthGrant = {
      type: "oauth",
      access: "old",
      refresh: "refresh-old",
      expires: 1,
      projectId: "fixture-project",
      projectReady: true,
    };
    let exchanges = 0,
      writes = 0,
      business = 0;
    const retained: Promise<unknown>[] = [];
    const caller = new AbortController();
    const driver = new GoogleAuthDriver(channel, async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        exchanges++;
        entered.resolve();
        await gate.promise;
        assert.equal(init?.signal?.aborted, false);
        return Response.json({
          access_token: "new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        });
      }
      business++;
      return Response.json({ buckets: [] });
    });
    const context: AuthDriverContext = {
      connectionId: "fixture-account",
      signal: caller.signal,
      read: async () => grant,
      write: async (next) => {
        grant = next;
      },
      captureRefreshCommit: () => async (next) => {
        writes++;
        grant = next;
      },
      retainRefreshCompletion: (operation) => {
        retained.push(operation);
      },
    };
    const cancelled = driver.quota(context);
    let callerSettled = false;
    void cancelled.then(
      () => {
        callerSettled = true;
      },
      () => {
        callerSettled = true;
      },
    );
    const rejected = assert.rejects(cancelled, { name: "AbortError" });
    void rejected.catch(() => {});
    await entered.promise;
    const kept = driver.quota({ ...context, signal: undefined });
    void kept.catch(() => {});
    caller.abort();
    try {
      await setImmediate();
      assert.equal(callerSettled, true);
      gate.resolve();
      await rejected;
      await kept;
      await Promise.all(retained);
      assert.equal(exchanges, 1);
      assert.equal(writes, 1);
      // 两种渠道的健康 quota 路径各有两次协议请求，取消的 caller 不再进入 quota。
      assert.equal(grant.refresh, "refresh-new");
      assert.equal(business, 2);
    } finally {
      gate.resolve();
      await Promise.allSettled([rejected, kept]);
      await driver.dispose();
    }
  });

test("Google refresh without a new refresh_token preserves the old token", async () => {
  let grant: AuthGrant = {
    type: "oauth",
    refresh: "stable-refresh",
    expires: 1,
    projectId: "fixture",
    projectReady: true,
  };
  let writes = 0;
  const driver = new GoogleAuthDriver("gemini", async (input) =>
    String(input).includes("/token")
      ? Response.json({ access_token: "new", expires_in: 3600 })
      : Response.json({ buckets: [] }),
  );
  await driver.quota({
    read: async () => grant,
    write: async (next) => {
      writes++;
      grant = next;
    },
  });
  assert.equal(grant.refresh, "stable-refresh");
  assert.equal(writes, 1);
  await driver.dispose();
});
