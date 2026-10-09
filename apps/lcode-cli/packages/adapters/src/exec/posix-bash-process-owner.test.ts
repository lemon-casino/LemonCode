import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { createPosixBashProcessOwner, type PosixBashMember } from "./posix-bash-process-owner.js";

for (const platform of ["linux", "darwin"] as const) {
  test(`${platform}: root exit settles owned group and preserves unrelated groups`, async () => {
    const member: PosixBashMember = {
      pid: 421,
      group: 420,
      session: 420,
      identity: "owned-birth",
      startedAt: Date.now(),
    };
    let rows = [
      member,
      { ...member, pid: 431, group: 430 },
      { ...member, pid: 721, group: 720, session: 720, identity: "other-birth" },
    ];
    const signals: number[] = [];
    const owner = createPosixBashProcessOwner(platform, {
      members: async () => rows,
      signal: (group) => {
        signals.push(group);
        rows = rows.filter((row) => row.group !== group);
      },
    });
    const child = Object.assign(new EventEmitter(), { pid: 420 }) as ChildProcess;
    owner.attach(child);
    child.emit("exit", 0);
    await owner.settle();
    await owner.settle();
    assert.deepEqual(signals, [420, 430]);
    assert.deepEqual(
      rows.map((row) => row.pid),
      [721],
    );
  });

  test(`${platform}: cleanup retry cannot signal a reused PID/group`, async () => {
    let row: PosixBashMember = {
      pid: 421,
      group: 420,
      session: 420,
      identity: "original-birth",
      startedAt: Date.now(),
    };
    let attempts = 0;
    const owner = createPosixBashProcessOwner(platform, {
      members: async () => [row],
      signal: () => {
        attempts++;
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    });
    owner.attach(Object.assign(new EventEmitter(), { pid: 420 }) as ChildProcess);
    await assert.rejects(owner.settle(), /denied/);
    row = { ...row, identity: "reused-birth" };
    await owner.settle();
    assert.equal(attempts, 1);
  });

  test(`${platform}: unavailable OS identity is not treated as confirmed exit`, async () => {
    const owner = createPosixBashProcessOwner(platform, {
      members: async () => {
        throw new Error("process lookup unavailable");
      },
      signal: () => assert.fail("must not signal without OS evidence"),
    });
    owner.attach(Object.assign(new EventEmitter(), { pid: 420 }) as ChildProcess);
    await assert.rejects(owner.settle(), /lookup unavailable/);
  });
}
