import assert from "node:assert/strict";
import test from "node:test";
import type { RunSettlement } from "@zcode/dynamic-workflow";
import { createRunServiceLifecycle } from "./dynamic-workflow-run-lifecycle.js";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";

test("terminal cleanup survives registry eviction and close waits for lineage lease release", async () => {
  const retries: Array<() => void> = [];
  const residency: Promise<unknown>[] = [];
  let releaseAttempts = 0;
  const entry: RunRegistryEntry = {
    controller: new AbortController(),
    cwd: "C:/workspace",
    executionFailoverLineageLease: Promise.resolve({
      foregroundExecutionId: "foreground-1",
      leaseId: "run-release-retry",
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("release append failed");
      },
    }),
    scriptText: "return 'ok'",
    settlement: Promise.resolve({ status: "stopped", reason: "user" }),
    startedAt: new Date(0),
  };
  const runs = new Map([["run-release-retry", entry]]);
  const lifecycle = createRunServiceLifecycle({
    cleanupRetrySchedule: (callback) => {
      retries.push(callback);
      return () => undefined;
    },
    journal: { getRun: () => undefined },
    parentSessionId: "session-parent",
    registerResidencyBlockingWork: (work) => residency.push(work),
    runs,
  });
  const expected = { status: "completed", artifact: "done" } satisfies RunSettlement;

  entry.settlement = lifecycle.trackSettlement(
    "run-release-retry",
    entry,
    Promise.resolve(expected),
  );
  assert.deepEqual(await entry.settlement, expected);
  // cleanup 与业务 settlement 解耦，并且还要等待 acquisition promise；让两段微任务都落稳。
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(entry.terminal, expected);
  assert.equal(releaseAttempts, 1);
  assert.ok(entry.executionFailoverLineageLease);
  assert.equal(retries.length, 1);
  assert.equal(residency.length, 1);

  for (let index = 0; index < 32; index += 1) {
    const fillerRunId = `filler-${index}`;
    const filler: RunRegistryEntry = {
      controller: new AbortController(),
      cwd: "C:/workspace",
      scriptText: "return 'ok'",
      settlement: Promise.resolve({ status: "stopped", reason: "user" }),
      startedAt: new Date(index + 1),
    };
    runs.set(fillerRunId, filler);
    filler.settlement = lifecycle.trackSettlement(fillerRunId, filler, Promise.resolve(expected));
    await filler.settlement;
  }
  assert.equal(runs.has("run-release-retry"), false);

  let closeSettled = false;
  const close = lifecycle.close().then(() => {
    closeSettled = true;
  });
  await Promise.resolve();
  assert.equal(closeSettled, false);

  retries.shift()?.();
  await Promise.all([residency[0], close]);

  assert.equal(releaseAttempts, 2);
  assert.equal(entry.executionFailoverLineageLease, undefined);
  assert.equal(closeSettled, true);
});
