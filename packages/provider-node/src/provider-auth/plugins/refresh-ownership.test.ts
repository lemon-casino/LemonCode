import assert from "node:assert/strict";
import test from "node:test";
import { PluginRefreshOwnership } from "./refresh-ownership.js";
import type { AuthDriverContext, AuthGrant } from "../driver.js";

const grant: AuthGrant = { type: "oauth", access: "fixture-old", refresh: "fixture-refresh" };
test("refresh ownership requires both Host capabilities and uncancelled original admission", async () => {
  const owner = new PluginRefreshOwnership(() => true);
  const caller = new AbortController();
  let captures = 0;
  const context: AuthDriverContext = {
    signal: caller.signal,
    read: async () => grant,
    write: async () => {},
    captureRefreshCommit: () => {
      captures++;
      return async () => {};
    },
  };
  assert.equal(await owner.begin(1, context, () => true), false);
  context.retainRefreshCompletion = () => {};
  caller.abort();
  assert.equal(await owner.begin(1, context, () => true), false);
  assert.equal(captures, 0);
  await assert.rejects(
    owner.begin(NaN, context, () => true),
    /Invalid/,
  );
});

test("cancelled caller keeps only one fixed CAS and shutdown waits for its actual write", async () => {
  let active = true,
    captures = 0,
    writes = 0;
  const caller = new AbortController(),
    gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const retained: Promise<unknown>[] = [];
  const owner = new PluginRefreshOwnership(() => active);
  const context: AuthDriverContext = {
    signal: caller.signal,
    read: async () => grant,
    write: async () => {
      assert.fail("ordinary write after cancellation");
    },
    captureRefreshCommit: () => {
      captures++;
      return async () => {
        writes++;
        entered.resolve();
        await gate.promise;
      };
    },
    retainRefreshCompletion: (done) => {
      retained.push(done);
    },
  };
  assert.equal(await owner.begin(1, context, () => true), true);
  assert.equal(await owner.begin(1, context, () => true), true);
  caller.abort();
  assert.equal(owner.read(1), grant);
  const writing = owner.write(1, { ...grant, access: "fixture-next" });
  await entered.promise;
  active = false;
  let settled = false;
  const closing = owner.shutdown().then(() => {
    settled = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(captures, 1);
    assert.equal(writes, 1);
  } finally {
    gate.resolve();
    await Promise.all([writing, closing, ...retained]);
  }
  assert.equal(owner.size, 0);
  assert.equal(await owner.write(1, grant), false);
});

test("stale CAS fails without ordinary fallback and unfinished rotation remains observable", async () => {
  const owner = new PluginRefreshOwnership(() => true);
  const retained: Promise<unknown>[] = [];
  const stale = new Error("stale generation");
  const context: AuthDriverContext = {
    read: async () => grant,
    write: async () => {
      assert.fail();
    },
    captureRefreshCommit: () => async () => {
      throw stale;
    },
    retainRefreshCompletion: (done) => {
      retained.push(done);
    },
  };
  await owner.begin(1, context, () => true);
  await assert.rejects(owner.write(1, grant), stale);
  await owner.end(1, true);
  await assert.rejects(retained[0]!, /without a confirmed/);
  await owner.begin(2, context, () => true);
  await owner.end(2, false);
  await retained[1];
});
