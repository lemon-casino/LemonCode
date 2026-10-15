import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIAuthDriver } from "./openai.js";
import type { AuthDriverContext, AuthGrant } from "../driver.js";

test("caller cancellation detaches from one owned refresh and preserves rotated credentials", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshes = 0,
    writes = 0;
  let grant: AuthGrant = {
    type: "oauth",
    access: "fixture-old",
    refresh: "fixture-refresh",
    expires: 1,
  };
  const caller = new AbortController();
  const driver = new OpenAIAuthDriver("codex", async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/oauth/token")) {
      refreshes++;
      entered();
      await gate;
      assert.equal(request.signal.aborted, false);
      return Response.json({
        access_token: "fixture-new",
        refresh_token: "fixture-rotated",
        expires_in: 3600,
      });
    }
    return Response.json({});
  });
  const context: AuthDriverContext = {
    connectionId: "fixture-account",
    read: async () => grant,
    write: async () => {
      throw new Error("ordinary write cannot persist cancelled work");
    },
    captureRefreshCommit: () => async (next) => {
      writes++;
      grant = next;
    },
    retainRefreshCompletion: () => {},
    signal: caller.signal,
  };
  try {
    const cancelled = driver.quota(context);
    await started;
    const kept = driver.quota({ ...context, signal: undefined });
    caller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    release();
    await kept;
    assert.equal(refreshes, 1);
    assert.equal(writes, 1);
    assert.equal(grant.refresh, "fixture-rotated");
  } finally {
    release();
    await driver.dispose();
  }
});

test("driver shutdown aborts and drains its refresh without accepting a late rotation", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let writes = 0;
  const driver = new OpenAIAuthDriver("codex", async (_input, init) => {
    entered();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  });
  const pending = driver.quota({
    read: async () => ({ type: "oauth", refresh: "fixture", expires: 1 }),
    write: async () => {
      writes++;
    },
  });
  const rejected = assert.rejects(pending);
  await started;
  await driver.dispose();
  await rejected;
  assert.equal(writes, 0);
});
