import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { prepareBashProcessOwner } from "./bash-process-owner.js";

test("Windows owner waits for actual job emptiness before closing its ownership handle", async () => {
  let count = 1;
  let closed = false;
  let terminated = false;
  const owner = await prepareBashProcessOwner("win32", async () => ({
    assign: (pid) => assert.equal(pid, 42),
    terminate: () => {
      terminated = true;
    },
    activeCount: () => count,
    close: () => {
      closed = true;
    },
  }));
  owner.attach({ pid: 42 } as ChildProcess);
  const settlement = owner.settle();
  await setTimeout(30);
  assert.equal(terminated, true);
  assert.equal(closed, false, "sending termination is not proof of exit");
  count = 0;
  await settlement;
  assert.equal(closed, true);
});

test("Windows owner preserves its handle after query failure and can retry", async () => {
  let unavailable = true;
  let closes = 0;
  const owner = await prepareBashProcessOwner("win32", async () => ({
    assign: () => {},
    terminate: () => {},
    activeCount: () => {
      if (unavailable) throw new Error("query failed");
      return 0;
    },
    close: () => {
      closes++;
    },
  }));
  await assert.rejects(owner.settle(), /query failed/);
  assert.equal(closes, 0);
  unavailable = false;
  await owner.settle();
  assert.equal(closes, 1);
});
