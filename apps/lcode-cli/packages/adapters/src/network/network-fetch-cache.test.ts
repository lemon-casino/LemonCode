import assert from "node:assert/strict";
import test from "node:test";
import { NetworkFetchCache } from "./network-fetch-cache.js";
import { createNetworkProxyFetch } from "./proxy-fetch.js";
import type { ManagedNetworkFetch } from "./proxy-fetch.js";

test("model cache preserves the original upload cancellation completion", async () => {
  const gate = Promise.withResolvers<void>(),
    reading = Promise.withResolvers<void>();
  const cache = new NetworkFetchCache();
  let cancels = 0,
    closed = false;
  const request = new Request("https://example.test", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          cancels++;
          return gate.promise;
        },
      },
      { highWaterMark: 0 },
    ),
  } as RequestInit);
  const fetch = cache.fetchFor("fixture", (onIdle) =>
    createNetworkProxyFetch({
      forceDirect: true,
      onIdle,
      fetch: async () => new Response("unexpected"),
    }),
  );
  const fetching = assert.rejects(fetch(request), { name: "AbortError" });
  await reading.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = cache.disposeAndWait().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancels, 1);
    assert.equal(closed, false, "cache must not hide the original source behind a pipeThrough");
  } finally {
    gate.resolve();
    await Promise.all([fetching, closing]);
  }
});

test("failed retired resources remain owned and retry without closing successful resources again", async () => {
  const cache = new NetworkFetchCache(0);
  let closes = 0;
  const fetch = Object.assign(async () => new Response("fixture"), {
    activeRequestCount: 0,
    dispose() {},
    async disposeAndWait() {
      if (++closes === 1) throw new Error("fixture close failure");
    },
  }) as ManagedNetworkFetch;
  await cache.fetchFor("fixture", () => fetch)("https://example.test");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(cache.disposeAndWait(), /cleanup failed/);
  await cache.disposeAndWait();
  await cache.disposeAndWait();
  assert.equal(closes, 2);
});

test("idle policy eviction preserves active bodies and old bindings rebuild their original route", async () => {
  const cache = new NetworkFetchCache(2);
  let created = 0;
  const route = (name: string) =>
    cache.fetchFor(name, (onIdle) => {
      created++;
      return createNetworkProxyFetch({
        forceDirect: true,
        onIdle,
        fetch: async () => new Response(name),
      });
    });
  const old = route("old");
  const held = await old("https://example.test");
  for (const name of ["second", "third", "fourth"])
    assert.equal(await (await route(name)("https://example.test")).text(), name);
  assert.equal(created, 4);
  assert.equal(await held.text(), "old", "active body must survive idle eviction");
  assert.equal(await (await old("https://example.test")).text(), "old");
  assert.equal(created, 5, "old binding recreates its frozen route after eviction");
  const closing = cache.disposeAndWait();
  assert.equal(cache.disposeAndWait(), closing);
  await closing;
  await assert.rejects(old("https://example.test"), /disposed/);
});
