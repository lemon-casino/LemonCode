import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";
import { withApiKeyLease } from "./api-key-fetch.js";

const keys = ["a", "b"].map((id) => ({ id, apiKey: `synthetic-${id}`, enabled: true }));
test("HTTP headers and Runner release cannot free an active response body or permit a duplicate POST", async () => {
  const registry = new ApiKeyPoolRegistry();
  const pool = registry.get("fixture", "generation", keys.slice(0, 1), {
    version: 1,
    strategy: "primary-backup",
  });
  const lease = pool.reserve();
  let calls = 0;
  const send = withApiKeyLease(
    async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
        }),
      );
    },
    lease,
    "openai",
  );
  const response = await send("https://fixture.invalid", { method: "POST" });
  lease.release();
  assert.throws(() => pool.reserve(), /concurrency-full/);
  await assert.rejects(send("https://fixture.invalid", { method: "POST" }), /already-dispatched/);
  assert.equal(calls, 1);
  await response.body!.cancel();
  const next = pool.reserve();
  next.release();
  registry.dispose();
});

test(
  "abort racing with response headers retains the slot until body cancellation physically settles",
  { timeout: 1500 },
  async () => {
    const registry = new ApiKeyPoolRegistry();
    const pool = registry.get("fixture", "generation", keys.slice(0, 1), {
      version: 1,
      strategy: "primary-backup",
    });
    const controller = new AbortController();
    const lease = pool.reserve({
      attemptId: "abort",
      scopeKey: "scope",
      signal: controller.signal,
    });
    let cancel!: () => void, end!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const physicalEnd = new Promise<void>((resolve) => {
      end = resolve;
    });
    const complete = lease.end!;
    lease.end = (success) => {
      complete(success);
      end();
    };
    const send = withApiKeyLease(
      async () => {
        controller.abort();
        return new Response(new ReadableStream({ cancel: () => cancellation }));
      },
      lease,
      "openai",
    );
    await assert.rejects(send("https://fixture.invalid", { signal: controller.signal }));
    lease.release();
    assert.throws(() => pool.reserve(), /concurrency-full/);
    cancel();
    await physicalEnd;
    const next = pool.reserve();
    next.release();
    registry.dispose();
  },
);

test(
  "closing a pending read on abort is not evidence that upstream cancellation has settled",
  { timeout: 1500 },
  async () => {
    const registry = new ApiKeyPoolRegistry();
    const pool = registry.get("fixture", "generation", keys.slice(0, 1), {
      version: 1,
      strategy: "primary-backup",
    });
    const controller = new AbortController();
    const lease = pool.reserve({
      attemptId: "pending-read",
      scopeKey: "scope",
      signal: controller.signal,
    });
    let cancel!: () => void, end!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const physicalEnd = new Promise<void>((resolve) => {
      end = resolve;
    });
    const complete = lease.end!;
    lease.end = (success) => {
      complete(success);
      end();
    };
    const send = withApiKeyLease(
      async () =>
        new Response(
          new ReadableStream({
            start(output) {
              output.enqueue(new Uint8Array([1]));
            },
            cancel: () => cancellation,
          }),
        ),
      lease,
      "openai",
    );
    const response = await send("https://fixture.invalid", { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    controller.abort();
    await pending;
    lease.release();
    assert.throws(() => pool.reserve(), /concurrency-full/);
    cancel();
    await physicalEnd;
    const next = pool.reserve();
    next.release();
    registry.dispose();
  },
);
test("explicit primary routing and legacy rotation are different, routing changes retain authentication failures", () => {
  const registry = new ApiKeyPoolRegistry();
  const legacy = registry.get("fixture", "generation", keys);
  for (const id of ["a", "b", "a"]) {
    const lease = legacy.reserve();
    assert.equal(lease.key.id, id);
    lease.release();
  }
  const primary = registry.get("fixture", "generation", keys, {
    version: 1,
    strategy: "primary-backup",
  });
  for (const id of ["a", "a", "a"]) {
    const lease = primary.reserve();
    assert.equal(lease.key.id, id);
    lease.release();
  }
  const rejected = primary.reserve();
  rejected.observe(401);
  rejected.release();
  const changed = registry.get("fixture", "generation", keys, {
    version: 1,
    strategy: "share-rotation",
  });
  const next = changed.reserve();
  assert.equal(next.key.id, "b");
  next.release();
  registry.dispose();
});

test("API routing keeps concurrent reservations until physical release and learns both upstream windows", () => {
  const registry = new ApiKeyPoolRegistry();
  const pool = registry.get("fixture", "generation", keys, {
    version: 1,
    strategy: "headroom-balance",
  });
  const a = pool.reserve(),
    b = pool.reserve();
  assert.notEqual(a.key.id, b.key.id);
  assert.throws(() => pool.reserve(), /concurrency-full/);
  a.observe(
    200,
    new Headers({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "90000",
    }),
  );
  a.release();
  b.release();
  const next = pool.reserve();
  assert.equal(next.key.id, b.key.id);
  next.release();
  registry.dispose();
});
