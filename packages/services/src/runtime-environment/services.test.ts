import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { nextGenerationAfter, reconcileStartIntent } from "./domain/services.js";
import {
  startManagedService,
  stopManagedService,
  type ServiceStageContext,
} from "./app/serviceStage.js";
import type { ManagedServiceReceipt } from "@lcode/shared";

async function withTempDir<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lcode-m3-services-"));
  try {
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RECORD = {
  environmentId: "e".repeat(32),
  scope: { workspacePath: "C:/proj" },
  purpose: "worktree" as const,
  status: "ready" as const,
  currentRevision: 1,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
};

const DEFINITION = {
  serviceId: "dev-server",
  purpose: "project dev server",
  argv: ["pnpm", "dev"],
  cwd: "C:/proj",
  ports: [5173],
};

function fakeProcesses(
  options: {
    urls?: string[];
    stopConfirms?: boolean;
  } = {},
) {
  const exits: Array<(exitCode: number) => Promise<void>> = [];
  return {
    port: {
      start: async () => ({ pid: 4242, urls: options.urls ?? ["http://127.0.0.1:5173"] }),
      stop: async () => (options.stopConfirms === false ? undefined : { exitCode: 0 }),
      onExit: (
        _key: { environmentId: string; serviceId: string; generation: number },
        callback: (exitCode: number) => Promise<void>,
      ) => {
        exits.push(callback);
      },
    },
    exits,
  };
}

function createContext(
  store: ReturnType<typeof createRuntimeEnvironmentStore>,
  processes: ReturnType<typeof fakeProcesses>["port"],
  probe?: (url: string) => Promise<boolean>,
): ServiceStageContext {
  return { store, processes, probe, stamp: () => "2026-10-05T00:00:00.000Z" };
}

test("start marks running only with verified listening URL; generation increments after stop", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const processes = fakeProcesses();
    const context = createContext(store, processes.port, async () => true);
    const first = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(first.status, "started");
    assert.equal(first.receipt.state, "running");
    assert.equal(first.receipt.generation, 1);
    assert.ok(first.receipt.healthCheckedAt);
    assert.deepEqual(first.receipt.urls, ["http://127.0.0.1:5173"]);
    // 并发/重复 start 同收据（spec §12.1）。
    const reused = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(reused.status, "reused");
    assert.equal(reused.receipt.generation, 1);
    // 停止有进程 owner 退出证明；再次 start 分配新 generation。
    const stopped = await stopManagedService(context, RECORD, "dev-server");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.receipt.stoppedAt !== undefined, true);
    const second = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(second.status, "started");
    assert.equal(second.receipt.generation, 2);
  });
});

test("start without any verified URL refuses running and settles failed (no fake ready)", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const processes = fakeProcesses();
    const context = createContext(store, processes.port, async () => false);
    const result = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(result.status, "failed");
    assert.equal(result.receipt?.state, "failed");
    assert.equal(result.receipt?.error, "no listening address verified");
    const stopped = await stopManagedService(context, RECORD, "dev-server");
    assert.equal(stopped.status, "notRunning");
  });
});

test("revision mismatch returns needsRestart instead of silent replace", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const processes = fakeProcesses();
    const context = createContext(store, processes.port, async () => true);
    await startManagedService(context, RECORD, DEFINITION);
    const updated = { ...RECORD, currentRevision: 2 };
    const result = await startManagedService(context, updated, DEFINITION);
    assert.equal(result.status, "needsRestart");
    const latest = await store.readServiceReceipt(RECORD.environmentId, "dev-server");
    assert.equal(latest?.state, "running");
    assert.equal(latest?.generation, 1);
  });
});

test("stop without process owner confirmation does not fake stopped", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const processes = fakeProcesses({ stopConfirms: false });
    const context = createContext(store, processes.port, async () => true);
    await startManagedService(context, RECORD, DEFINITION);
    const result = await stopManagedService(context, RECORD, "dev-server");
    assert.equal(result.status, "stopFailed");
    const latest = await store.readServiceReceipt(RECORD.environmentId, "dev-server");
    assert.equal(latest?.state, "failed");
    assert.match(latest?.error ?? "", /did not confirm/);
  });
});

test("unexpected process exit settles the running receipt as stopped via owner callback", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const processes = fakeProcesses();
    const context = createContext(store, processes.port, async () => true);
    await startManagedService(context, RECORD, DEFINITION);
    assert.equal(processes.exits.length, 1);
    await processes.exits[0]!(143);
    const latest = await store.readServiceReceipt(RECORD.environmentId, "dev-server");
    assert.equal(latest?.state, "stopped");
    assert.equal(latest?.exitCode, 143);
  });
});

test("generation helper and start intent reconcile", () => {
  const previous = { generation: 3 } as ManagedServiceReceipt;
  assert.equal(nextGenerationAfter(previous), 4);
  assert.equal(nextGenerationAfter(null), 1);
  assert.equal(reconcileStartIntent({ existing: null, requestedRevision: 1 }).action, "start");
});
