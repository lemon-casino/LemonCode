import assert from "node:assert/strict";
import test from "node:test";
import { createProxyConnectivityTester } from "./proxyConnectivity.js";

test("batch proxy checks bound concurrency and report request facts without errors or credentials", async (t) => {
  let active = 0,
    maximum = 0,
    calls = 0;
  const tester = createProxyConnectivityTester(
    async () => ({}),
    async (input, init) => {
      const index = calls++;
      maximum = Math.max(maximum, ++active);
      assert.ok(new Request(input, init).signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      if (index === 1) throw new Error("fixture-private-password");
      return new Response("ok", { status: index === 2 ? 503 : 200 });
    },
  );
  t.after(() => tester.dispose());
  const profiles = Array.from({ length: 7 }, (_, index) => ({
    id: String(index),
    name: "Fixture",
    httpProxy: "http://user:private@proxy.example:7890",
  }));
  const results = await tester.test(profiles);
  assert.equal(maximum, 3);
  assert.deepEqual(
    results.map((result) => result.status),
    ["reachable", "failed", "failed", "reachable", "reachable", "reachable", "reachable"],
  );
  assert.ok(results.every((result) => result.latencyMs >= 0));
  assert.equal(JSON.stringify(results).includes("private"), false);
  tester.dispose();
  await assert.rejects(tester.test(profiles), /abort/i);
});

test("cancelling a batch stops admission and does not label cancellation as failure", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const tester = createProxyConnectivityTester(
    async () => ({}),
    async (input, init) => {
      if (++calls === 3) entered.resolve();
      const signal = new Request(input, init).signal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
      return new Response("never");
    },
  );
  t.after(() => tester.dispose());
  const operation = tester.test(
    Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      name: "Fixture",
      httpProxy: "http://proxy.example:7890",
    })),
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  assert.deepEqual(await operation, []);
  assert.equal(calls, 3);
});

test("proxy owner waits physical SSE cancellation and keeps queued profiles unsent", async () => {
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  let calls = 0,
    cancels = 0,
    closed = false;
  const tester = createProxyConnectivityTester(
    async () => ({}),
    async () => {
      if (++calls === 3) entered.resolve();
      return new Response(
        new ReadableStream({
          cancel() {
            cancels++;
            return gate.promise;
          },
        }),
      );
    },
  );
  const batch = tester.test(
    Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      name: "Fixture",
      httpProxy: "http://proxy.example:7890",
    })),
  );
  void batch.catch(() => {});
  await entered.promise;
  const closing = tester.disposeAndWait().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal(calls, 3);
  } finally {
    gate.resolve();
    await Promise.allSettled([batch, closing]);
  }
  assert.equal(cancels, 3);
});
