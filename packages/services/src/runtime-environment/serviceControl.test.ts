import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeEnvironmentRecord,
  RuntimeEnvironmentServiceActionParams,
} from "@lcode/shared";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createServiceControl } from "./app/serviceControl.js";
import type { ServiceProcessPort } from "./app/ports.js";

async function fixture(
  action: (data: {
    store: ReturnType<typeof createRuntimeEnvironmentStore>;
    record: RuntimeEnvironmentRecord;
    request: RuntimeEnvironmentServiceActionParams;
    control: ReturnType<typeof createServiceControl>;
    calls: Array<Parameters<ServiceProcessPort["start"]>[0]>;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-service-control-"));
  const store = createRuntimeEnvironmentStore(join(dir, "records"));
  const record: RuntimeEnvironmentRecord = {
    environmentId: "a".repeat(32),
    scope: { workspacePath: dir, workspaceIdentity: "remote-test" },
    purpose: "worktree",
    currentRevision: 1,
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.saveEnvironment(record);
  const request: RuntimeEnvironmentServiceActionParams = {
    ...record.scope,
    environmentId: record.environmentId,
    serviceId: "dev",
    requestId: "start-1",
    expectedRevision: 1,
  };
  const calls: Array<Parameters<ServiceProcessPort["start"]>[0]> = [];
  const control = createServiceControl({
    store,
    processes: {
      start: async (params) => {
        calls.push(params);
        return { pid: 42, urls: ["http://127.0.0.1:5173"] };
      },
      stop: async () => ({ exitCode: 0 }),
      onExit: () => {},
    },
    resolveDefinition: async (params, environment) =>
      params.serviceId === "dev"
        ? {
            serviceId: "dev",
            purpose: "test",
            argv: ["node", "server.js"],
            cwd: environment.scope.workspacePath,
            env: { LCODE_DATA_BASE_DIR: join(dir, "private") },
          }
        : null,
    resolveContext: async (environment) => ({
      environmentId: environment.environmentId,
      revision: environment.currentRevision,
      cwd: dir,
      manifestDigest: "frozen",
      executionScope: record.scope,
      toolPaths: { node: process.execPath },
      envOverlay: { base: "empty", set: { TEST_FROZEN: "yes" } },
      resourceLeaseToken: "not-public",
    }),
    probe: async () => true,
  });
  try {
    await action({ store, record, request, control, calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("controller accepts only a trusted service ID and applies the exact frozen environment", async () => {
  await fixture(async ({ control, request, calls }) => {
    const missing = await control.startService({ ...request, serviceId: "arbitrary-command" });
    assert.equal(missing.status, "blocked");
    const result = await control.startService(request);
    assert.equal(result.status, "started");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.argv[0], process.execPath);
    assert.equal(calls[0]?.env?.TEST_FROZEN, "yes");
    assert.ok(calls[0]?.env?.LCODE_DATA_BASE_DIR);
    assert.equal(calls[0]?.env?.HOME, undefined);
    assert.doesNotMatch(JSON.stringify(result), /not-public|TEST_FROZEN/);
  });
});

test("scope, revision and generation are rechecked before touching a live service", async () => {
  await fixture(async ({ control, request, calls }) => {
    assert.equal(
      (await control.startService({ ...request, workspaceIdentity: "another" })).status,
      "blocked",
    );
    assert.equal(
      (await control.startService({ ...request, expectedRevision: 2 })).status,
      "needsRestart",
    );
    assert.equal((await control.startService(request)).status, "started");
    assert.equal(
      (await control.stopService({ ...request, expectedGeneration: 2 })).status,
      "needsRestart",
    );
    assert.equal(
      (await control.startService({ ...request, expectedGeneration: 2 })).status,
      "needsRestart",
    );
    assert.equal(calls.length, 1);
  });
});

test("stopAll stops owned services after a fence without taking the long stop under the lock", async () => {
  await fixture(async ({ control, request, record, store }) => {
    await control.startService(request);
    const fenced = { ...record, status: "releasing" as const };
    await store.lock(record.environmentId, () => store.saveEnvironment(fenced));
    assert.equal((await control.startService({ ...request, requestId: "late" })).status, "blocked");
    const result = await control.stopAll(fenced);
    assert.equal(result.status, "stopped");
    assert.ok(result.receipts[0]?.stoppedAt);
    assert.deepEqual(result.receipts[0]?.urls, []);
  });
});

test("a repeated request cannot resurrect its stopped generation", async () => {
  await fixture(async ({ control, request, calls }) => {
    await control.startService(request);
    await control.stopService({ ...request, requestId: "stop-1", expectedGeneration: 1 });
    const retry = await control.startService(request);
    assert.notEqual(retry.status, "started");
    assert.equal(calls.length, 1);
  });
});

test("service mutations advance the shared environment fact version", async () => {
  await fixture(async ({ control, request, record, store }) => {
    const before = await store.readEnvironment(record.environmentId);
    const started = await control.startService(request);
    const current = await store.readEnvironment(record.environmentId);
    assert.ok((current?.stateRevision ?? 0) > (before?.stateRevision ?? 0));
    assert.equal(started.receipt?.stateRevision, current?.stateRevision);
    const stopped = await control.stopService({ ...request, requestId: "stop-1" });
    assert.ok((stopped.receipt?.stateRevision ?? 0) > (started.receipt?.stateRevision ?? 0));
  });
});
