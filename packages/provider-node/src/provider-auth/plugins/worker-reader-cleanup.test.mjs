import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createWorkerReaderCleanup } from "./worker-reader-cleanup.mjs";

test("worker retains removed operation reader cancellation and coalesces repeats", async () => {
  const cleanup = createWorkerReaderCleanup(),
    gate = Promise.withResolvers();
  let cancels = 0,
    drained = false;
  const scope = {
    controller: new AbortController(),
    reader: {
      cancel: () => {
        cancels++;
        return gate.promise;
      },
    },
  };
  cleanup.cancel(scope);
  cleanup.cancel(scope);
  const closing = cleanup.drain().then(() => {
    drained = true;
  });
  await setImmediate();
  assert.equal(cancels, 1);
  assert.equal(drained, false);
  gate.resolve();
  await closing;
});

test("worker reports real reader cleanup failure but tolerates only its own abort reason", async () => {
  const cleanup = createWorkerReaderCleanup(),
    controller = new AbortController();
  controller.abort();
  cleanup.cancel({
    controller,
    reader: {
      cancel: async () => {
        throw controller.signal.reason;
      },
    },
  });
  await cleanup.drain();
  cleanup.cancel({
    controller,
    reader: {
      cancel: async () => {
        throw new Error("fixture reader close failure");
      },
    },
  });
  await assert.rejects(cleanup.drain(), /fixture reader close failure/);
});

test("worker normal EOF cancellation remains observable when it rejects", async () => {
  const cleanup = createWorkerReaderCleanup();
  cleanup.cancel({
    controller: new AbortController(),
    reader: {
      cancel: async () => {
        throw new Error("EOF cleanup failed");
      },
    },
  });
  await assert.rejects(cleanup.drain(), /EOF cleanup failed/);
});
