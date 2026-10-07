import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { FrozenManifest, RuntimeEnvironmentRecord } from "@lcode/shared";
import { acquireFileLock } from "@lcode/shared/node";
import { createRuntimeResources } from "./adapters/resources.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { scopeKeyHash } from "./app/ports.js";

const ENV_ID = "a".repeat(32);
const AT = "2026-10-06T00:00:00.000Z";
const BUDGET = { maxEntries: 20_000, maxDurationMs: 2_000 };
const PLATFORM = "windows-x64";
const BACKEND = "v2026.10.2";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lcode-resource-gc-"));
  const dataDir = join(root, "managed");
  const store = createRuntimeEnvironmentStore(dataDir);
  const resources = createRuntimeResources(dataDir);
  const platformRoot = join(dataDir, "tool-store", "mise", BACKEND, PLATFORM);
  async function tool(version = "24.14.0", kind: "installs" | "downloads" = "installs") {
    const path = join(platformRoot, "data", kind, "node", version);
    await mkdir(path, { recursive: true });
    const executable = join(path, kind === "installs" ? "node.exe" : "download.zip");
    await writeFile(executable, "fixture");
    return { path, executable, lock: join(platformRoot, `${PLATFORM}-node-${version}.lock`) };
  }
  function manifest(toolPath: string): FrozenManifest {
    return { schemaVersion: 1, backendVersion: BACKEND, os: "windows", arch: "x64",
      tools: [{ key: "node", version: "24.14.0", source: "app-default", installStrategy: "managed-tool-store", toolPath }],
      declarationDigest: "declaration", manifestDigest: "manifest", installStrategy: "frozen", createdAt: AT };
  }
  async function environment(toolPath: string, overrides: Partial<RuntimeEnvironmentRecord> = {}) {
    const record: RuntimeEnvironmentRecord = { environmentId: ENV_ID, scope: { workspacePath: join(root, "checkout") },
      status: "released", purpose: "worktree", currentRevision: 1, manifestDigest: "manifest", createdAt: AT, updatedAt: AT, ...overrides };
    await store.saveManifest(record.environmentId, 1, manifest(toolPath));
    await store.saveEnvironment(record);
    return record;
  }
  const collect = (request: string, dryRun = false, budget = BUDGET) => resources.collect({
    operationId: scopeKeyHash([request]), budget, dryRun,
  });
  return { root, dataDir, store, resources, platformRoot, tool, manifest, environment, collect,
    close: () => rm(root, { recursive: true, force: true }) };
}

test("dry run lists released zero-reference tools and downloads without touching private or bundled data", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    const download = await f.tool("24.14.0", "downloads");
    await f.environment(tool.executable);
    const dirs = await f.resources.ensure(ENV_ID);
    await writeFile(join(dirs.data, "database"), "keep private");
    const bundled = join(f.dataDir, "tool-backends", BACKEND, PLATFORM, "mise.exe");
    await mkdir(dirname(bundled), { recursive: true });
    await writeFile(bundled, "keep bundled");
    const preview = await f.collect("preview", true);
    assert.equal(preview.status, "succeeded");
    assert.equal(preview.deletedEntries, 0);
    assert.equal(preview.candidates.filter((candidate) => candidate.state === "eligible").length, 2);
    await access(tool.executable);
    await access(download.executable);
    const deleted = await f.collect("delete");
    assert.equal(deleted.status, "succeeded");
    assert.equal(deleted.deletedEntries, 2);
    await assert.rejects(access(tool.path), { code: "ENOENT" });
    await assert.rejects(access(download.path), { code: "ENOENT" });
    assert.equal(await readFile(join(dirs.data, "database"), "utf8"), "keep private");
    assert.equal(await readFile(bundled, "utf8"), "keep bundled");
  } finally { await f.close(); }
});

test("ready bindings protect their tools even when no consumer is currently running", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    await f.environment(tool.executable, { status: "ready", bindingId: "binding" });
    const result = await f.collect("ready");
    assert.equal(result.deletedEntries, 0);
    assert.equal(result.protectedEntries, 1);
    assert.ok((result.summary.protectedReferences ?? 0) > 0);
    await access(tool.executable);
  } finally { await f.close(); }
});

test("a succeeded preparation's unresolved historical plan does not protect unrelated tools forever", async () => {
  const f = await fixture();
  try {
    const ready = await f.tool();
    const unused = await f.tool("24.15.0");
    await f.environment(ready.executable, { status: "ready", bindingId: "binding" });
    const plan = f.manifest(ready.executable);
    plan.tools = [{ key: "node", version: "24.14.0", source: "app-default" }];
    await f.store.saveOperation({ operationId: "b".repeat(32), requestId: "succeeded", environmentId: ENV_ID,
      status: "succeeded", stage: "ready", cancelRequested: false, targetRevision: 1, plan, createdAt: AT, updatedAt: AT });
    const result = await f.collect("settled-plan");
    assert.equal(result.status, "succeeded");
    assert.equal(result.protectedEntries, 1);
    assert.equal(result.deletedEntries, 1);
    await access(ready.executable);
    await assert.rejects(access(unused.executable), { code: "ENOENT" });
  } finally { await f.close(); }
});

for (const owner of ["consumer", "service"] as const) {
  test(`active old revision ${owner} keeps its immutable manifest's tool protected`, async () => {
    const f = await fixture();
    try {
      const oldTool = await f.tool();
      const newTool = await f.tool("24.15.0");
      const next = f.manifest(newTool.executable);
      next.tools[0]!.version = "24.15.0";
      await f.environment(oldTool.executable, { currentRevision: 2 });
      await f.store.saveManifest(ENV_ID, 2, next);
      if (owner === "consumer") await f.store.saveConsumers(ENV_ID, [{ environmentId: ENV_ID, revision: 1,
        kind: "process", id: "old-process", ownerId: "host", ownerGeneration: 1, lease: "private", state: "active", createdAt: AT, updatedAt: AT }]);
      else await f.store.saveServiceReceipt({ environmentId: ENV_ID, revision: 1, serviceId: "old-service", generation: 1,
        state: "running", urls: ["http://127.0.0.1:3000"], startedAt: AT, healthCheckedAt: AT });
      const result = await f.collect(`old-${owner}`);
      assert.equal(result.protectedEntries, 1);
      assert.equal(result.deletedEntries, 1);
      await access(oldTool.executable);
      await assert.rejects(access(newTool.executable), { code: "ENOENT" });
    } finally { await f.close(); }
  });
}

test("a live preparation globally protects unrelated candidates, including a cancellation in progress", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    const second = await f.tool("24.15.0");
    await f.environment(tool.executable);
    await f.store.saveOperation({ operationId: "b".repeat(32), requestId: "prepare", environmentId: "c".repeat(32),
      status: "running", stage: "cancelling", cancelRequested: true, createdAt: AT, updatedAt: AT });
    const result = await f.collect("live-prepare");
    assert.equal(result.status, "blocked");
    assert.equal(result.deletedEntries, 0);
    assert.equal(result.protectedEntries, 2);
    await access(tool.executable);
    await access(second.executable);
  } finally { await f.close(); }
});

test("a preparation lease protects globally even if its operation was marked cancelled", async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | null = null;
  try {
    const tool = await f.tool();
    await f.environment(tool.executable);
    release = await f.store.claimPreparation(ENV_ID);
    assert.ok(release);
    const result = await f.collect("lease");
    assert.equal(result.status, "blocked");
    assert.equal(result.deletedEntries, 0);
    await access(tool.executable);
  } finally { await release?.(); await f.close(); }
});

test("cancelled install remains protected by the exact toolBackend lock, never reclaimed by age", async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | undefined;
  try {
    const tool = await f.tool();
    await f.environment(tool.executable);
    await f.store.saveOperation({ operationId: "b".repeat(32), requestId: "cancelled-install", environmentId: ENV_ID,
      status: "cancelled", stage: "cancelled", cancelRequested: true, createdAt: AT, updatedAt: AT });
    release = await acquireFileLock(tool.lock, [], 0, 0);
    const lockDir = `${tool.lock}.lock`;
    const ownerFile = join(lockDir, (await readdir(lockDir))[0]!);
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    await writeFile(ownerFile, JSON.stringify({ ...owner, createdAt: 1 }));
    const blocked = await f.collect("locked");
    assert.equal(blocked.deletedEntries, 0);
    assert.equal(blocked.protectedEntries, 1);
    assert.equal(blocked.status, "blocked");
    await access(ownerFile);
    await access(tool.executable);
    await release(); release = undefined;
    assert.equal((await f.collect("unlocked")).deletedEntries, 1);
  } finally { await release?.(); await f.close(); }
});

for (const kind of ["records", "manifests", "consumers", "services", "operations"] as const) {
  test(`corrupt ${kind} prevents deletion rather than being interpreted as no references`, async () => {
    const f = await fixture();
    try {
      const tool = await f.tool();
      await f.environment(tool.executable);
      const dir = join(f.dataDir, kind);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${"d".repeat(32)}.json`), "{broken");
      const result = await f.collect(`corrupt-${kind}`);
      assert.equal(result.deletedEntries, 0);
      assert.notEqual(result.status, "succeeded");
      assert.notEqual(result.summary.status, "complete");
      await access(tool.executable);
    } finally { await f.close(); }
  });
}

test("entry budget exhaustion while proving references blocks all candidates", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    await f.environment(tool.executable);
    const result = await f.collect("too-small", false, { maxEntries: 1, maxDurationMs: 2_000 });
    assert.equal(result.status, "partial");
    assert.equal(result.deletedEntries, 0);
    assert.equal(result.summary.status, "partial");
    await access(tool.executable);
  } finally { await f.close(); }
});

test("redirected tool trees fail closed without removing other candidates or user data", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    await f.environment(tool.executable);
    const outside = join(f.root, "user-data");
    await mkdir(outside);
    await writeFile(join(outside, "database"), "keep");
    await symlink(outside, join(tool.path, "redirect"), process.platform === "win32" ? "junction" : "dir");
    const result = await f.collect("symlink");
    assert.equal(result.deletedEntries, 0);
    assert.notEqual(result.status, "succeeded");
    assert.equal(await readFile(join(outside, "database"), "utf8"), "keep");
    await access(tool.executable);
  } finally { await f.close(); }
});

test("GC journal replays the same result across adapters without deleting a reinstalled tool", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    await f.environment(tool.executable);
    const operationId = scopeKeyHash(["idempotent"]);
    const params = { operationId, budget: BUDGET, dryRun: false };
    const result = await f.resources.collect(params);
    assert.equal(result.deletedEntries, 1);
    await f.tool();
    assert.deepEqual(await createRuntimeResources(f.dataDir).collect(params), result);
    await access(tool.executable);
    await assert.rejects(f.resources.collect({ ...params, dryRun: true }), /stale-reference/iu);
  } finally { await f.close(); }
});

test("orphan manifests and missing old revisions prevent a false complete reference proof", async () => {
  const f = await fixture();
  try {
    const tool = await f.tool();
    await f.environment(tool.executable, { currentRevision: 2 });
    const result = await f.collect("missing-revision");
    assert.equal(result.deletedEntries, 0);
    assert.notEqual(result.status, "succeeded");
    await f.store.removeEnvironment(ENV_ID);
    const orphan = await f.collect("orphan");
    assert.equal(orphan.deletedEntries, 0);
    assert.notEqual(orphan.status, "succeeded");
    await access(tool.executable);
  } finally { await f.close(); }
});
