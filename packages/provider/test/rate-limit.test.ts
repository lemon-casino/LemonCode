import assert from "node:assert/strict";
import test from "node:test";
import { readRateLimitHint, RateLimitWindow } from "../src/rate-limit.js";

test("only explicit Key scope isolates a Key; durations reject malformed and clamp excessive hints", () => {
  const now = Date.UTC(2026, 9, 13);
  assert.deepEqual(
    readRateLimitHint(new Headers({ "x-lcode-rate-limit-scope": "key", "retry-after": "2" }), now),
    { scope: "key", delayMs: 2000 },
  );
  assert.equal(
    readRateLimitHint(new Headers({ "retry-after": new Date(now + 4000).toUTCString() }), now)
      .delayMs,
    4000,
  );
  for (const scope of ["team", "organization", "unknown", ""])
    assert.equal(
      readRateLimitHint(new Headers({ "x-lcode-rate-limit-scope": scope })).scope,
      "shared",
    );
  for (const value of ["-1", "NaN", "Infinity", "2x", ""])
    assert.equal(readRateLimitHint(new Headers({ "retry-after-ms": value }), now).delayMs, 1000);
  assert.equal(readRateLimitHint(new Headers({ "retry-after-ms": "9999999" })).delayMs, 300000);
});

test("common deadlines only extend; cancellation and owner disposal stop waiting", async () => {
  let now = 100;
  const window = new RateLimitWindow(() => now);
  window.extend(400);
  now = 200;
  window.extend(50);
  assert.equal(window.remainingMs(), 300);
  const controller = new AbortController();
  const waiting = window.wait(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const closing = window.wait();
  window.dispose();
  await assert.rejects(closing, { name: "AbortError" });
});
