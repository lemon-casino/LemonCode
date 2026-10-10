import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createNativeProcessOwnerObserver } from "./adapters/processOwnerObservation.js";
import type { RuntimeConsumerProcessOwner } from "./contract.js";

const owner: RuntimeConsumerProcessOwner = {
  runtimeInstanceId: "11111111-1111-4111-8111-111111111111",
  runtimeGeneration: 1,
  workspacePath: process.cwd(),
  startedAt: Date.now(),
  pid: process.pid,
};

test("native observation distinguishes a live and exited actual process; retained ownership remains protected", async (t) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end();
    await exited;
  });
  await once(child, "spawn");
  const ref = { ...owner, pid: child.pid };
  let retained = false;
  const observe = createNativeProcessOwnerObserver(() => retained);
  assert.equal(await observe(ref), "present");
  child.stdin.end();
  await exited;
  assert.equal(await observe(ref), "absent");
  retained = true;
  assert.equal(await observe(ref), "present");
});

test("missing registry, missing PID and observation errors cannot authorize administrative retirement", async () => {
  assert.equal(await createNativeProcessOwnerObserver()(owner), "unknown");
  assert.equal(
    await createNativeProcessOwnerObserver(() => false)({ ...owner, pid: undefined }),
    "unknown",
  );
  assert.equal(
    await createNativeProcessOwnerObserver(() => {
      throw new Error("registry unavailable");
    })(owner),
    "unknown",
  );
  assert.equal(
    await createNativeProcessOwnerObserver(() => {
      throw Object.assign(new Error("registry failed"), { code: "ESRCH" });
    })(owner),
    "unknown",
  );
});

test("OS permission errors remain unknown and cannot retire a foreign live owner", async (t) => {
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("process cannot be inspected"), { code: "EPERM" });
  });
  assert.equal(await createNativeProcessOwnerObserver(() => false)(owner), "unknown");
});
