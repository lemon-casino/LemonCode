import assert from "node:assert/strict";
import test from "node:test";
import { runtimeMemoryBudget } from "@lcode/shared/node";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";

const workspace = { workspacePath: process.cwd() };
const commandResolver = () => ({
  command: process.execPath,
  args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
});

test("memory refusal never publishes a process owner", async (t) => {
  t.mock.method(runtimeMemoryBudget, "acquire", async () => {
    throw new Error("runtime memory budget unavailable");
  });
  const manager = new LCodeAgentProcessManager({ commandResolver });
  await assert.rejects(manager.getClient(workspace), /memory budget/);
  assert.deepEqual(manager.listOwnedWorkspaceTargets(), []);
  await manager.disposeAllAndWait();
});

test("dispose during memory admission releases the reservation without spawning", async (t) => {
  const admission = Promise.withResolvers<{ heapMb: number; release(): void }>();
  const entered = Promise.withResolvers<void>();
  let released = 0;
  t.mock.method(runtimeMemoryBudget, "acquire", () => {
    entered.resolve();
    return admission.promise;
  });
  const manager = new LCodeAgentProcessManager({ commandResolver });
  const starting = manager.getClient(workspace);
  const rejected = assert.rejects(starting, /cancelled/);
  await entered.promise;
  const closing = manager.disposeAllAndWait();
  admission.resolve({
    heapMb: 256,
    release: () => {
      released++;
    },
  });
  await rejected;
  await closing;
  assert.equal(released, 1);
  assert.deepEqual(manager.listOwnedWorkspaceTargets(), []);
});

test("spawn failure releases its lease so a later request can retry", async (t) => {
  const reservations = new Set<symbol>();
  t.mock.method(runtimeMemoryBudget, "acquire", async () => {
    const token = Symbol();
    reservations.add(token);
    return {
      heapMb: 256,
      release: () => {
        reservations.delete(token);
      },
    };
  });
  const manager = new LCodeAgentProcessManager({
    commandResolver: () => ({ command: "lcode-memory-fixture-does-not-exist" }),
  });
  const client = await manager.getClient(workspace);
  await assert.rejects(client.request("runtime/capabilities", {}, undefined, { timeoutMs: 1000 }));
  await manager.disposeAllAndWait();
  assert.equal(reservations.size, 0);
});

test("Agent reservation stays owned until the existing process-tree cleanup barrier completes", async (t) => {
  let released = 0;
  t.mock.method(runtimeMemoryBudget, "acquire", async () => ({
    heapMb: 256,
    release: () => {
      released++;
    },
  }));
  const manager = new LCodeAgentProcessManager({ commandResolver });
  const client = await manager.getClient(workspace);
  const cleanup = client.disposeAndWait.bind(client);
  const exited = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  t.mock.method(client, "disposeAndWait", async () => {
    await cleanup();
    exited.resolve();
    await releaseCleanup.promise;
  });
  const closing = manager.disposeAllAndWait();
  await exited.promise;
  assert.equal(released, 0);
  releaseCleanup.resolve();
  await closing;
  assert.equal(released, 1);
});
