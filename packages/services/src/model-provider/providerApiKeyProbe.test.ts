import assert from "node:assert/strict";
import test from "node:test";
import { runProviderApiKeyProbe } from "./providerApiKeyProbe.js";

test("100k probes use eight workers, bounded progress and preserve result order", async () => {
  const keys = Array.from({ length: 100_000 }, (_, index) => ({ id: String(index) }));
  let active = 0;
  let peak = 0;
  let completed = 0;
  const results = await runProviderApiKeyProbe(
    keys,
    async (key) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { keyId: key.id, status: "valid" };
    },
    {
      onProgress: (progress) => {
        assert.ok(progress.results.length <= 64);
        assert.ok(progress.completed >= completed);
        completed = progress.completed;
      },
    },
  );
  assert.equal(peak, 8);
  assert.equal(completed, 100_000);
  assert.deepEqual(
    results.map((result) => result.keyId),
    keys.map((key) => key.id),
  );
});

test("stop aborts in-flight signals and never dispatches the remaining 100k queue", async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const results = await runProviderApiKeyProbe(
    Array.from({ length: 100_000 }, (_, index) => ({ id: String(index) })),
    async (_key, signal) => {
      signals.push(signal);
      if (signals.length === 8) queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    },
    { signal: controller.signal },
  );
  assert.equal(signals.length, 8);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.deepEqual(results, []);
});

test("a stalled transport times out even if it ignores AbortSignal, then the pool proceeds", async () => {
  let calls = 0;
  const results = await runProviderApiKeyProbe(
    Array.from({ length: 10 }, (_, index) => ({ id: String(index) })),
    async () => {
      calls++;
      return new Promise(() => {});
    },
    { timeoutMs: 5 },
  );
  assert.equal(calls, 10);
  assert.ok(
    results.every((result) => result.status === "error" && result.message === "Request timed out"),
  );
});

test("stop keeps completed invalid/valid/error results and excludes aborted requests", async () => {
  const controller = new AbortController();
  const results = await runProviderApiKeyProbe(
    Array.from({ length: 30 }, (_, index) => ({ id: String(index) })),
    async (key) => {
      if (Number(key.id) < 3)
        return {
          keyId: key.id,
          status: ["invalid", "valid", "error"][Number(key.id)] as "invalid" | "valid" | "error",
        };
      return new Promise(() => {});
    },
    {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.completed === 3) controller.abort();
      },
    },
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["invalid", "valid", "error"],
  );
});
