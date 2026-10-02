import assert from "node:assert/strict";
import test from "node:test";
import { getProviderApiKeyPage, removeInvalidProviderApiKeys } from "./providerApiKeyList.js";

test("100k keys keep pages bounded and only include 25 visible records", () => {
  assert.deepEqual(getProviderApiKeyPage(100_001, 4_001), {
    page: 4_001,
    pages: 4_001,
    start: 100_000,
    end: 100_001,
    total: 100_001,
  });
  assert.equal(
    getProviderApiKeyPage(100_000, 100).end - getProviderApiKeyPage(100_000, 100).start,
    25,
  );
});

test("deletion and invalid page requests clamp immediately, including empty lists", () => {
  assert.equal(getProviderApiKeyPage(25, 2).page, 1);
  assert.equal(getProviderApiKeyPage(0, 4_000).page, 1);
  assert.equal(getProviderApiKeyPage(100, -1).page, 1);
  assert.equal(getProviderApiKeyPage(100, Number.NaN).page, 1);
});

test("delete invalid keys removes only explicit IDs across all pages", () => {
  const keys = Array.from({ length: 60 }, (_, index) => ({
    id: String(index),
    apiKey: `demo-${index}`,
    enabled: index !== 1,
  }));
  const next = removeInvalidProviderApiKeys(keys, new Set(["0", "59"]));
  assert.equal(next.length, 58);
  assert.ok(next.some((key) => key.id === "1" && !key.enabled));
  assert.ok(next.some((key) => key.id === "2"));
  assert.equal(keys.length, 60);
});
