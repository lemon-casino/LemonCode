import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeEnvironmentServiceForTests } from "./node.js";
import type { ProjectDeclarations } from "./domain/declarations.js";
import type { ToolBackendPort } from "./app/ports.js";

const declarations = (digest = "a"): ProjectDeclarations => ({
  tools: [{ key: "node", constraint: "24.14.0", exact: true, source: ".node-version" }],
  lockfiles: [],
  ambiguousLocks: false,
  issues: [],
  configurationDigests: { ".npmrc": digest.repeat(64) },
});
const backend = (overrides: Partial<ToolBackendPort> = {}): ToolBackendPort => ({
  ensureBackend: async () => "/bundled/mise",
  probeBackend: async () => ({ available: true }),
  installTool: async ({ key, version }) => ({ toolPath: `/managed/${key}/${version}/${key}` }),
  ...overrides,
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-preparation-"));
  const store = createRuntimeEnvironmentStore(root);
  return {
    root,
    store,
    scope: { workspacePath: root, workspaceIdentity: "test-project" },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("cancel is durable and a late tool completion cannot publish ready", async () => {
  const f = await fixture();
  try {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = createRuntimeEnvironmentServiceForTests({
      store: f.store,
      declarations: { read: async () => declarations() },
      backend: backend({
        installTool: async () => {
          entered();
          await wait;
          return { toolPath: "/managed/node" };
        },
      }),
    });
    const params = { ...f.scope, requestId: "cancel-race", purpose: "worktree" as const };
    const pending = service.prepare(params);
    await started;
    const cancel = await service.prepare({ ...params, cancel: true });
    assert.equal(cancel.cancelRequested, true);
    assert.notEqual(cancel.status, "succeeded");
    finish();
    assert.equal((await pending).status, "cancelled");
    assert.equal((await service.prepare(params)).status, "cancelled");
    assert.equal((await f.store.readEnvironment(cancel.environmentId))?.status, "cancelled");
    assert.equal(await f.store.readManifest(cancel.environmentId, 1), null);
  } finally {
    await f.close();
  }
});

test("a second request does not reset revision; explicit upgrade freezes a new immutable manifest", async () => {
  const f = await fixture();
  try {
    let parsed = declarations();
    const service = createRuntimeEnvironmentServiceForTests({
      store: f.store,
      declarations: { read: async () => parsed },
      backend: backend(),
    });
    const first = await service.prepare({ ...f.scope, requestId: "first", purpose: "worktree" });
    const original = await f.store.readManifest(first.environmentId, 1);
    assert.match(original?.declarationDigest ?? "", /^[a-f0-9]{64}$/);
    assert.match(original?.manifestDigest ?? "", /^[a-f0-9]{64}$/);
    parsed = declarations("b");
    const update = await service.get({ ...f.scope, environmentId: first.environmentId });
    assert.equal(update?.status, "needsUpdate");
    const upgraded = await service.prepare({
      ...f.scope,
      requestId: "upgrade",
      purpose: "worktree",
      operation: "upgrade",
      expectedRevision: 1,
    });
    assert.equal(upgraded.status, "succeeded");
    const record = await f.store.readEnvironment(first.environmentId);
    assert.equal(record?.currentRevision, 2);
    assert.deepEqual(await f.store.readManifest(first.environmentId, 1), original);
    assert.notEqual(
      (await f.store.readManifest(first.environmentId, 2))?.manifestDigest,
      original?.manifestDigest,
    );
    const stale = await service.prepare({
      ...f.scope,
      requestId: "stale",
      purpose: "worktree",
      operation: "upgrade",
      expectedRevision: 1,
    });
    assert.equal(stale.error?.code, "stale-reference");
    assert.equal((await f.store.readEnvironment(first.environmentId))?.currentRevision, 2);
  } finally {
    await f.close();
  }
});

test("a frozen lock cannot become ready without an install owner", async () => {
  const f = await fixture();
  try {
    const service = createRuntimeEnvironmentServiceForTests({
      store: f.store,
      backend: backend(),
      declarations: {
        read: async () => ({
          ...declarations(),
          lockfiles: [{ name: "pnpm-lock.yaml", digest: "a".repeat(64) }],
        }),
      },
    });
    const op = await service.prepare({
      ...f.scope,
      requestId: "dependencies",
      purpose: "worktree",
    });
    assert.equal(op.status, "failed");
    assert.equal(op.error?.code, "capability-unavailable");
    assert.equal(await f.store.readManifest(op.environmentId, 1), null);
  } finally {
    await f.close();
  }
});

test("unavailable bundled backend rejects preparation rather than claiming managed ready", async () => {
  const f = await fixture();
  try {
    const service = createRuntimeEnvironmentServiceForTests({
      store: f.store,
      declarations: { read: async () => declarations() },
      backend: backend({
        probeBackend: async () => ({ available: false, reason: "missing bundled mise" }),
      }),
    });
    assert.equal((await service.getCapabilities(f.scope)).managedEnvironments, false);
    const op = await service.prepare({ ...f.scope, requestId: "missing", purpose: "worktree" });
    assert.equal(op.status, "failed");
    assert.equal(op.error?.code, "capability-unavailable");
  } finally {
    await f.close();
  }
});

test("same request with a different binding cannot reuse an unrelated operation", async () => {
  const f = await fixture();
  try {
    const service = createRuntimeEnvironmentServiceForTests({
      store: f.store,
      declarations: { read: async () => declarations() },
      backend: backend(),
    });
    await service.prepare({
      ...f.scope,
      requestId: "stable",
      purpose: "worktree",
      bindingId: "one",
    });
    await assert.rejects(
      service.prepare({ ...f.scope, requestId: "stable", purpose: "worktree", bindingId: "two" }),
      /scope-mismatch/,
    );
  } finally {
    await f.close();
  }
});
