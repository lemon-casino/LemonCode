import assert from "node:assert/strict";
import test from "node:test";
import { createProxyConnectivityTester } from "./proxyConnectivity.js";

test("batch proxy checks bound concurrency and report request facts without errors or credentials", async (t) => {
  let active = 0,
    maximum = 0,
    calls = 0;
  const tester = createProxyConnectivityTester(
    async () => ({}),
    async (_url, init) => {
      const index = calls++;
      maximum = Math.max(maximum, ++active);
      assert.ok(init?.signal);
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
  const tester = createProxyConnectivityTester(
    async () => ({}),
    async (_url, init) => {
      calls++;
      await new Promise<void>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
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
  controller.abort();
  assert.deepEqual(await operation, []);
  assert.equal(calls, 3);
});
