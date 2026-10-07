import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createRuntimeResources } from "./adapters/resources.js";
import { DEFAULT_RESOURCE_SCAN_BUDGET } from "./app/resourceControl.js";

const ENVIRONMENT_ID = "a".repeat(32);
const LARGE_BUDGET = { maxEntries: 20_000, maxDurationMs: 2_000 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lcode-resource-scan-"));
  const dataDir = join(root, "managed");
  return {
    root,
    dataDir,
    resources: createRuntimeResources(dataDir),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("ensure returns stable managed resource directories and preserves private data", async () => {
  const f = await fixture();
  try {
    const dirs = await f.resources.ensure(ENVIRONMENT_ID);
    for (const key of ["temp", "cache", "data", "logs"] as const) {
      assert.equal(dirs[key], join(f.dataDir, "resources", ENVIRONMENT_ID, key));
      await access(dirs[key]);
    }
    assert.equal(dirs.packageStore, join(f.dataDir, "package-store", "pnpm"));
    await access(dirs.packageStore);
    await writeFile(join(dirs.data, "database"), "private data");
    assert.deepEqual(await f.resources.ensure(ENVIRONMENT_ID), dirs);
    assert.equal(await readFile(join(dirs.data, "database"), "utf8"), "private data");
    await assert.rejects(f.resources.ensure("../escape"), /environment id/iu);
  } finally { await f.close(); }
});

test("scan counts only this environment's managed resources, never checkout node_modules", async () => {
  const f = await fixture();
  try {
    const dirs = await f.resources.ensure(ENVIRONMENT_ID);
    for (const key of ["temp", "cache", "data", "logs"] as const) {
      await writeFile(join(dirs[key], "payload"), key);
    }
    const checkout = join(f.root, "checkout", "node_modules", "huge-package");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "not-managed"), "x".repeat(10_000));
    const other = await f.resources.ensure("b".repeat(32));
    await writeFile(join(other.data, "not-this-environment"), "x".repeat(10_000));
    await writeFile(join(dirs.packageStore, "shared-cache"), "x".repeat(10_000));
    const summary = await f.resources.scan(ENVIRONMENT_ID, LARGE_BUDGET);
    assert.equal(summary.status, "complete");
    assert.equal(summary.fileCount, 4);
    assert.equal(summary.bytes, 17);
    assert.deepEqual(summary.scanBudget, LARGE_BUDGET);
  } finally { await f.close(); }
});

test("scan reports partial when the entry budget is exhausted and clamps hard limits", async () => {
  const f = await fixture();
  try {
    const dirs = await f.resources.ensure(ENVIRONMENT_ID);
    await writeFile(join(dirs.temp, "payload"), "1234");
    assert.deepEqual(DEFAULT_RESOURCE_SCAN_BUDGET, { maxEntries: 2_000, maxDurationMs: 200 });
    const partial = await f.resources.scan(ENVIRONMENT_ID, { maxEntries: 1, maxDurationMs: 2_000 });
    assert.equal(partial.status, "partial");
    assert.match(partial.reason ?? "", /budget/iu);
    const capped = await f.resources.scan(ENVIRONMENT_ID, { maxEntries: 1_000_000, maxDurationMs: 100_000 });
    assert.deepEqual(capped.scanBudget, LARGE_BUDGET);
    assert.equal(capped.status, "complete");
    await assert.rejects(f.resources.scan(ENVIRONMENT_ID, { maxEntries: 0, maxDurationMs: 10 }), /budget/iu);
  } finally { await f.close(); }
});

test("scan checks the monotonic time budget without using a timeout as success", async (t) => {
  const f = await fixture();
  try {
    await f.resources.ensure(ENVIRONMENT_ID);
    let reads = 0;
    t.mock.method(performance, "now", () => (++reads < 5 ? 0 : 3));
    const summary = await f.resources.scan(ENVIRONMENT_ID, { maxEntries: 2_000, maxDurationMs: 2 });
    assert.equal(summary.status, "partial");
    assert.match(summary.reason ?? "", /budget/iu);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("a missing resource directory is unavailable rather than an empty complete scan", async () => {
  const f = await fixture();
  try {
    const summary = await f.resources.scan(ENVIRONMENT_ID, LARGE_BUDGET);
    assert.equal(summary.status, "unavailable");
    assert.equal(summary.bytes, undefined);
    await assert.rejects(access(f.dataDir), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("symlinks and Windows junctions fail closed without traversing checkout", async () => {
  const f = await fixture();
  try {
    const dirs = await f.resources.ensure(ENVIRONMENT_ID);
    const outside = join(f.root, "checkout", "node_modules");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "private"), "keep");
    await symlink(outside, join(dirs.cache, "redirect"), process.platform === "win32" ? "junction" : "dir");
    const summary = await f.resources.scan(ENVIRONMENT_ID, LARGE_BUDGET);
    assert.equal(summary.status, "unavailable");
    await writeFile(join(dirs.temp, "keep-on-failed-clear"), "keep");
    await assert.rejects(f.resources.clearRebuildable(ENVIRONMENT_ID), /managed|symlink|containment/iu);
    await access(join(dirs.temp, "keep-on-failed-clear"));
    assert.equal(await readFile(join(outside, "private"), "utf8"), "keep");
  } finally { await f.close(); }
});

test("ensure refuses a redirected managed directory before creating children", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await mkdir(f.dataDir);
    await symlink(outside, join(f.dataDir, "resources"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(f.resources.ensure(ENVIRONMENT_ID), /managed|symlink|containment/iu);
    await assert.rejects(access(join(outside, ENVIRONMENT_ID)), { code: "ENOENT" });
    await assert.rejects(access(resolve(f.dataDir, "resources", ENVIRONMENT_ID)), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("clearRebuildable removes only temp/cache/logs and is repeatable, never data or shared stores", async () => {
  const f = await fixture();
  try {
    const dirs = await f.resources.ensure(ENVIRONMENT_ID);
    for (const key of ["temp", "cache", "data", "logs", "packageStore"] as const) {
      await writeFile(join(dirs[key], "payload"), key);
    }
    await f.resources.clearRebuildable(ENVIRONMENT_ID);
    await f.resources.clearRebuildable(ENVIRONMENT_ID);
    for (const key of ["temp", "cache", "logs"] as const) {
      await assert.rejects(access(dirs[key]), { code: "ENOENT" });
    }
    assert.equal(await readFile(join(dirs.data, "payload"), "utf8"), "data");
    assert.equal(await readFile(join(dirs.packageStore, "payload"), "utf8"), "packageStore");
    assert.deepEqual(await f.resources.ensure(ENVIRONMENT_ID), dirs);
  } finally { await f.close(); }
});
