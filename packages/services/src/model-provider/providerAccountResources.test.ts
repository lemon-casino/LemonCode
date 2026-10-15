import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import type { AuthDriver } from "@lcode/provider-node";
import { ProviderAccountRefreshOwner } from "./providerAccountRefreshOwner.js";
import { ProviderAccountDriverCleanup } from "./providerAccountDriverCleanup.js";

test("two Host account owners keep the original file lock until detached rotation completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-account-close-"));
  let release!: () => void;
  const rotation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const first = new ProviderAccountRefreshOwner(join(directory, "credentials"));
  const second = new ProviderAccountRefreshOwner(join(directory, "credentials"));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = first.run("fixture", async () => {
    first.retain("fixture", rotation);
    order.push("first");
    entered();
  });
  await started;
  const replacement = second.run("fixture", async () => {
    order.push("second");
  });
  try {
    await setImmediate();
    assert.deepEqual(order, ["first"]);
    release();
    await Promise.all([original, replacement]);
    assert.deepEqual(order, ["first", "second"]);
  } finally {
    release();
    await Promise.allSettled([original, replacement]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("account cleanup keeps each failure and only retries the original unfinished drivers", async () => {
  let first = 0,
    second = 0;
  const drivers = [
    {
      dispose: async () => {
        first++;
      },
    },
    {
      dispose: async () => {
        if (++second === 1) throw new Error("fixture close");
      },
    },
  ] as AuthDriver[];
  const owner = new ProviderAccountDriverCleanup();
  await assert.rejects(owner.close(drivers), /cleanup failed/);
  await owner.close(drivers);
  await owner.close(drivers);
  assert.equal(first, 1);
  assert.equal(second, 2);
});

test("account cleanup waits for pending construction and observes late retirement failure", async () => {
  const owner = new ProviderAccountDriverCleanup();
  const gate = Promise.withResolvers<void>();
  let activeClosed = false,
    lateCloses = 0,
    closed = false;
  const late = {
    dispose: async () => {
      if (++lateCloses === 1) throw new Error("late cleanup failure");
    },
  } as AuthDriver;
  const creating = owner.construct(async () => {
    await gate.promise;
    await owner.retire(late);
  });
  const constructionFailure = assert.rejects(creating, /late cleanup failure/);
  const closing = owner.close([
    {
      dispose: async () => {
        activeClosed = true;
      },
    } as AuthDriver,
  ]);
  const closeFailure = assert.rejects(closing, /cleanup failed/).then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(activeClosed, true);
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all([constructionFailure, closeFailure]);
  await owner.close([]);
  assert.equal(lateCloses, 2);
});
