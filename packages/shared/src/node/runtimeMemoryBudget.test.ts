import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeMemoryBudget, MIB } from "./runtimeMemoryBudget.js";

test("1 GiB admission reserves aggregate agent capacity and releases idempotently", async () => {
  const budget = createRuntimeMemoryBudget(async () => ({
    limitBytes: 1024 * MIB,
    availableBytes: 800 * MIB,
  }));
  const results = await Promise.allSettled([budget.acquire("agent"), budget.acquire("agent")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const first = results.find((result) => result.status === "fulfilled");
  assert.ok(first?.status === "fulfilled");
  assert.match(
    String(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ),
    /memory budget/i,
  );
  first.value.release();
  first.value.release();
  const retry = await budget.acquire("agent");
  assert.equal(retry.heapMb, 256);
  retry.release();
});

test("memory pressure refuses a new Worker without taking a lease", async () => {
  let availableBytes = 100 * MIB;
  const budget = createRuntimeMemoryBudget(async () => ({
    limitBytes: 1024 * MIB,
    availableBytes,
  }));
  await assert.rejects(budget.acquire("repl-worker"), /memory budget/i);
  availableBytes = 650 * MIB;
  const worker = await budget.acquire("repl-worker");
  await assert.rejects(budget.acquire("repl-worker"), /memory budget/i);
  worker.release();
  (await budget.acquire("repl-worker")).release();
});
