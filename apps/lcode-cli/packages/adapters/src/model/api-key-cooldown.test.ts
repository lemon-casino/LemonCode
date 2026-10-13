import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitWindow } from "@lcode/provider";
import { ApiKeyPool } from "./api-key-pool.js";
import { admitAttempt } from "./request-admission.js";
import { ApiKeyCooldownQueue } from "./api-key-cooldown-queue.js";

const keys = [
  { id: "a", apiKey: "synthetic-a", enabled: true },
  { id: "b", apiKey: "synthetic-b", enabled: true },
];
const keyHint = new Headers({ "x-lcode-rate-limit-scope": "key", "retry-after-ms": "2000" });

test("Key cooldown skips only the rejected Key, expires fairly and preserves auth failures", () => {
  let now = 0;
  const pool = new ApiKeyPool(keys, undefined, new RateLimitWindow(() => now));
  const a = pool.reserve();
  a.observe(429, keyHint);
  assert.equal(a.canRotate, true);
  a.release();
  const b = pool.reserve();
  assert.equal(b.key.id, "b");
  b.observe(401);
  b.release();
  assert.equal(pool.coolingKeyCount, 1);
  now = 2000;
  assert.equal(pool.reserve().key.id, "a");
  pool.dispose();
});

test("100k cooldown slots remain indexed without duplicate entries or early recovery", () => {
  const queue = new ApiKeyCooldownQueue();
  for (let index = 0; index < 100_000; index++) queue.extend(index, index + 1);
  queue.extend(0, 200_000);
  queue.extend(0, 1);
  assert.equal(queue.size, 100_000);
  assert.equal(queue.nextDeadline, 2);
  for (let index = 1; index < 100_000; index++) assert.equal(queue.popDue(100_000), index);
  assert.equal(queue.popDue(100_000), undefined);
  assert.equal(queue.popDue(200_000), 0);
  assert.equal(queue.size, 0);
});

test("all cooled Keys resume in order; owner cancellation releases pending leases", async () => {
  let now = 0;
  const pool = new ApiKeyPool(keys, undefined, new RateLimitWindow(() => now));
  for (let index = 0; index < 2; index++) {
    const lease = pool.reserve();
    lease.observe(429, keyHint);
    lease.release();
  }
  assert.equal(pool.availableCount, 0);
  const waiting = pool.acquire();
  pool.dispose();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(pool.activeLeaseCount, 0);
  const restored = new ApiKeyPool(keys, undefined, new RateLimitWindow(() => now));
  for (let index = 0; index < 2; index++) {
    const lease = restored.reserve();
    lease.observe(429, keyHint);
    lease.release();
  }
  now = 2000;
  const selected = [restored.reserve(), restored.reserve()];
  assert.deepEqual(
    selected.map((lease) => lease.key.id),
    ["a", "b"],
  );
  for (const lease of selected) lease.release();
  restored.dispose();
});

test("unknown 429 blocks the shared provider window across save pools and can be cancelled", async () => {
  const window = new RateLimitWindow();
  const first = new ApiKeyPool(keys, undefined, window);
  const saved = new ApiKeyPool(keys, undefined, window);
  const lease = first.reserve();
  lease.observe(429, new Headers({ "retry-after": "120" }));
  assert.equal(lease.canRotate, false);
  lease.release();
  const controller = new AbortController();
  const waiting = saved.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  first.dispose();
  saved.dispose();
  window.dispose();
});

test("cooldown waiting releases admission and cancellation never reacquires it", async () => {
  let active = 0,
    admitted = 0;
  const ticket = await admitAttempt({
    model: { providerId: "fixture", modelId: "fixture" },
    admission: {
      acquire: async () => {
        active++;
        admitted++;
        return {
          publish() {},
          release() {
            active--;
          },
        };
      },
    },
  });
  let resume!: () => void;
  const waiting = ticket.waitOutsideTicket!(async () => {
    assert.equal(active, 0);
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
  });
  assert.equal(active, 0);
  resume();
  await waiting;
  assert.equal(active, 1);
  assert.equal(admitted, 2);
  ticket.release();
  assert.equal(active, 0);
});

test(
  "closing Key owner cancels admission queued after cooldown has ended",
  { timeout: 3000 },
  async () => {
    const caller = new AbortController(),
      shared = new RateLimitWindow(),
      pool = new ApiKeyPool(keys, undefined, shared);
    shared.extend(10);
    let queued!: () => void,
      signal: AbortSignal | undefined,
      calls = 0;
    const inQueue = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const admission = await admitAttempt({
      model: { providerId: "fixture", modelId: "fixture" },
      signal: caller.signal,
      admission: {
        acquire: async (input) => {
          if (++calls === 1) return { publish() {}, release() {} };
          signal = input.signal;
          queued();
          return new Promise((_, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
          );
        },
      },
    });
    const outcome = pool
      .acquire(caller.signal, (wait, ownerSignal) =>
        admission.waitOutsideTicket!(wait, ownerSignal),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await inQueue;
      pool.dispose();
      assert.equal(signal?.aborted, true);
      assert.equal(((await outcome) as Error).name, "AbortError");
    } finally {
      caller.abort();
      pool.dispose();
      shared.dispose();
      admission.release();
      await outcome;
    }
  },
);
