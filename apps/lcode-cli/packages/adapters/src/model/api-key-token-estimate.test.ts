import assert from "node:assert/strict";
import test from "node:test";
import { apiKeyTokenBounds } from "./api-key-token-estimate.js";
test("routing uses conservative model/request bounds instead of the work quantum", () => {
  assert.deepEqual(apiKeyTokenBounds(100, 20), {
    input: 100,
    output: 20,
    total: 120,
    quality: "bound",
  });
  assert.deepEqual(apiKeyTokenBounds(100), {
    input: 100,
    output: 100,
    total: 200,
    quality: "bound",
  });
  assert.deepEqual(apiKeyTokenBounds(undefined, 20), {
    input: undefined,
    output: 20,
    total: undefined,
    quality: "bound",
  });
  assert.throws(() => apiKeyTokenBounds(100, -1), /invalid-work-estimate/);
});
