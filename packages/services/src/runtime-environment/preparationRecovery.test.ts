import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeEnvironmentServiceForTests } from "./node.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";
import type { ProjectDeclarations } from "./domain/declarations.js";
import type { ToolBackendPort } from "./app/ports.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-recovery-"));
  const store = createRuntimeEnvironmentStore(root);
  const scope = { workspacePath: root };
  const declarations: ProjectDeclarations = {
    tools: [],
    lockfiles: [],
    ambiguousLocks: false,
    issues: [],
  };
  const backend: ToolBackendPort = {
    ensureBackend: async () => "/bundled/mise",
    probeBackend: async () => ({ available: true }),
    installTool: async ({ key, version }) => ({ toolPath: `/managed/${key}/${version}/${key}` }),
  };
  const service = createRuntimeEnvironmentServiceForTests({
    store,
    backend,
    declarations: { read: async () => declarations },
  });
  return {
    root,
    scope,
    store,
    backend,
    declarations,
    service,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("failed retry after restart reuses the persisted exact range plan", async () => {
  const f = await fixture();
  try {
    f.declarations.tools = [
      { key: "node", constraint: "^24.0.0", source: "mise.toml", exact: false },
    ];
    let resolves = 0;
    let failing = true;
    f.backend.resolveVersion = async () => {
      resolves++;
      return "24.14.0";
    };
    const original = f.backend.installTool;
    f.backend.installTool = async (params) => {
      if (failing) throw new Error("interrupted download");
      return original(params);
    };
    const params = { ...f.scope, requestId: "retry", purpose: "worktree" as const };
    assert.equal((await f.service.prepare(params)).status, "failed");
    failing = false;
    const restarted = createRuntimeEnvironmentServiceForTests({
      store: createRuntimeEnvironmentStore(f.root),
      backend: f.backend,
      declarations: { read: async () => f.declarations },
    });
    const previous = await restarted.reconcile({ ...f.scope, requestId: params.requestId });
    assert.equal(
      (await restarted.prepare({ ...params, environmentId: previous.operation!.environmentId }))
        .status,
      "succeeded",
    );
    assert.equal(resolves, 1);
  } finally {
    await f.close();
  }
});
test("two Host preparations share one live writer without resetting its operation", async () => {
  const f = await fixture();
  try {
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let calls = 0;
    f.backend.installTool = async ({ key }) => {
      calls++;
      ready.resolve();
      await resume.promise;
      return { toolPath: `/managed/${key}` };
    };
    const params = { ...f.scope, requestId: "two-hosts", purpose: "worktree" as const };
    const first = f.service.prepare(params);
    await ready.promise;
    const peer = createRuntimeEnvironmentServiceForTests({
      store: createRuntimeEnvironmentStore(f.root),
      backend: f.backend,
      declarations: { read: async () => f.declarations },
    });
    const duplicate = await peer.prepare(params);
    assert.equal(duplicate.status, "running");
    const competing = await peer.prepare({ ...params, requestId: "competing" });
    assert.equal(competing.error?.code, "resource-busy");
    const unknown = await peer.reconcile({ ...f.scope, requestId: params.requestId });
    assert.equal(unknown.operation?.status, "running");
    resume.resolve();
    assert.equal((await first).status, "succeeded");
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});
test("archive fence retains session references; restore creates a fresh environment and migrates only confirmed sessions", async () => {
  const f = await fixture();
  try {
    const initial = await f.service.prepare({
      ...f.scope,
      requestId: "original",
      bindingId: "binding",
      purpose: "worktree",
    });
    const old = await f.store.readEnvironment(initial.environmentId);
    const authority = createRuntimeConsumerAuthority(f.store, () => new Date().toISOString());
    await authority.acquire({
      ...f.scope,
      environmentId: initial.environmentId,
      revision: 1,
      kind: "session",
      id: "parent",
      ownerId: "binding:binding",
    });
    const release = createWorktreeEnvironmentRelease({
      store: f.store,
      stamp: () => new Date().toISOString(),
      stopAll: async () => ({ status: "stopped" }),
      clearRebuildable: async () => {},
    });
    const request = {
      ...f.scope,
      environmentId: initial.environmentId,
      bindingId: "binding",
      expectedRevision: 1,
      requestId: "archive",
      intent: "archive" as const,
    };
    for (const phase of ["fence", "stop", "cleanup", "finalize"] as const)
      assert.equal((await release({ ...request, phase })).status, "completed");
    assert.equal((await f.store.listConsumers(initial.environmentId))[0]?.state, "active");
    const restore = await f.service.prepare({
      ...f.scope,
      requestId: "restore",
      bindingId: "binding",
      purpose: "worktree",
      operation: "restore",
      environmentId: initial.environmentId,
      expectedRevision: 1,
      expectedManifestDigest: old?.manifestDigest,
    });
    assert.equal(restore.status, "succeeded");
    assert.notEqual(restore.environmentId, initial.environmentId);
    await authority.migrateSessions!({
      ...f.scope,
      bindingId: "binding",
      fromEnvironmentId: initial.environmentId,
      toEnvironmentId: restore.environmentId,
      oldRevision: 1,
      revision: 1,
      sessionIds: ["parent"],
    });
    assert.equal((await f.store.listConsumers(initial.environmentId))[0]?.state, "released");
    assert.equal((await f.store.listConsumers(restore.environmentId))[0]?.state, "active");
    assert.deepEqual(await f.store.listServiceIds(restore.environmentId), []);
    await authority.migrateSessions!({
      ...f.scope,
      bindingId: "binding",
      fromEnvironmentId: initial.environmentId,
      toEnvironmentId: restore.environmentId,
      oldRevision: 1,
      revision: 1,
      sessionIds: ["parent"],
    });
    assert.equal((await f.store.listConsumers(restore.environmentId)).length, 1);
  } finally {
    await f.close();
  }
});
