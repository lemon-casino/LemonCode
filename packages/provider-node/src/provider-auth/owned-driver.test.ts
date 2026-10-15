import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AuthDriver } from "./driver.js";
import type { HostApiNetworkTransport } from "../network-transport.js";
import { createOwnedAuthDriver } from "./owned-driver.js";

test("native owner closes network despite driver failure and retries only the failed original resource", async () => {
  let driverCloses = 0,
    networkCloses = 0;
  const driver = await createOwnedAuthDriver(
    async () =>
      ({
        dispose: async () => {
          if (++driverCloses === 1) throw new Error("fixture driver close");
        },
      }) as AuthDriver,
    {
      disposeAndWait: async () => {
        networkCloses++;
      },
    } as HostApiNetworkTransport,
  );
  await assert.rejects(Promise.resolve(driver.dispose!()), AggregateError);
  assert.equal(networkCloses, 1);
  await driver.dispose!();
  await driver.dispose!();
  assert.equal(driverCloses, 2);
  assert.equal(networkCloses, 1);
});

test("native owner coalesces close, waits physical network cancellation and fences new operations", async () => {
  const gate = Promise.withResolvers<void>();
  let closed = false,
    called = false;
  const driver = await createOwnedAuthDriver(
    async () =>
      ({
        models: async () => {
          called = true;
          return [];
        },
      }) as unknown as AuthDriver,
    { disposeAndWait: () => gate.promise } as unknown as HostApiNetworkTransport,
  );
  const closing = driver.dispose!() as Promise<void>;
  assert.equal(driver.dispose!(), closing);
  void closing.then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  await assert.rejects(driver.models({ read: async () => null, write: async () => {} }), {
    name: "AbortError",
  });
  assert.equal(called, false);
  gate.resolve();
  await closing;
});

test("initialization failure drains the unused original network and preserves both failures", async () => {
  const original = new Error("fixture initialization"),
    cleanup = new Error("fixture network close");
  await assert.rejects(
    createOwnedAuthDriver(
      async () => {
        throw original;
      },
      {
        disposeAndWait: async () => {
          throw cleanup;
        },
      } as unknown as HostApiNetworkTransport,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
});
