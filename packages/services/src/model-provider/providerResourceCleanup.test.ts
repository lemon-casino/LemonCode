import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { ProviderResourceCleanup } from "./providerResourceCleanup.js";

test("provider resource progress starts independent cleanup, retains late work and retries only failures", async () => {
  const cleanup = new ProviderResourceCleanup(),
    gate = Promise.withResolvers<void>();
  let first = 0,
    second = 0,
    completed = false;
  const a = {},
    b = {};
  void cleanup.retain(a, async () => {
    first++;
    await gate.promise;
  });
  void cleanup.retain(b, () => {
    if (++second === 1) throw new Error("fixture close");
  });
  const closing = assert.rejects(cleanup.drain(), AggregateError).then(() => {
    completed = true;
  });
  await setImmediate();
  assert.equal(completed, false);
  assert.equal(first, 1);
  assert.equal(second, 1);
  gate.resolve();
  await closing;
  cleanup.retryFailed();
  await cleanup.drain();
  assert.equal(first, 1);
  assert.equal(second, 2);
});
