import assert from "node:assert/strict";
import test from "node:test";
import { NetworkFetchCache } from "./network-fetch-cache.js";
import { createNetworkProxyFetch } from "./proxy-fetch.js";

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
