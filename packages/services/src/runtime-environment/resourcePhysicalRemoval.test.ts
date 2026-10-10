import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { createRuntimeResources } from "./adapters/resources.js";

const id = "a".repeat(32);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-physical-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managed = join(root, "managed");
  const resources = createRuntimeResources(managed);
  return { root, managed, resources, dirs: await resources.ensure(id) };
}

test("lifecycle cleanup uses three physical roots and never applies scan time budgets", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.dirs.cache, "deep", "nested"), { recursive: true });
  await writeFile(join(f.dirs.cache, "deep", "nested", "app.asar"), "archive");
  await writeFile(join(f.dirs.data, "database"), "private");
  await writeFile(join(f.dirs.packageStore, "shared"), "keep");
  const targets: string[] = [];
  const resources = createRuntimeResources(f.managed, async (path) => {
    targets.push(path);
    await rm(path, { recursive: true, force: true });
  });
  let clocks = 0;
  t.mock.method(performance, "now", () => (++clocks === 1 ? 0 : 2501));
  await resources.clearRebuildable(id);
  assert.deepEqual(targets, [f.dirs.temp, f.dirs.cache, f.dirs.logs]);
  assert.equal(clocks, 0);
  assert.equal(await readFile(join(f.dirs.data, "database"), "utf8"), "private");
  assert.equal(await readFile(join(f.dirs.packageStore, "shared"), "utf8"), "keep");
});

test("redirected top-level cache is rejected before any other resource root is removed", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "payload"), "keep");
  await writeFile(join(f.dirs.temp, "payload"), "keep-temp");
  await rm(f.dirs.cache, { recursive: true, force: true });
  await symlink(outside, f.dirs.cache, process.platform === "win32" ? "junction" : "dir");
  const targets: string[] = [];
  const resources = createRuntimeResources(f.managed, async (path) => {
    targets.push(path);
  });
  await assert.rejects(resources.clearRebuildable(id), /managed|symlink|containment/iu);
  assert.deepEqual(targets, []);
  await access(join(f.dirs.temp, "payload"));
  assert.equal(await readFile(join(outside, "payload"), "utf8"), "keep");
});

test("a physical EBUSY preserves remaining roots and retry completes only owned targets", async (t) => {
  const f = await fixture(t);
  let busy = true;
  const resources = createRuntimeResources(f.managed, async (path) => {
    if (path === f.dirs.cache && busy)
      throw Object.assign(new Error("fixture locked cache"), { code: "EBUSY" });
    await rm(path, { recursive: true, force: true });
  });
  await assert.rejects(resources.clearRebuildable(id), { code: "EBUSY" });
  await assert.rejects(access(f.dirs.temp), { code: "ENOENT" });
  await access(f.dirs.cache);
  await access(f.dirs.data);
  busy = false;
  await resources.clearRebuildable(id);
  await resources.clearRebuildable(id);
  for (const path of [f.dirs.temp, f.dirs.cache, f.dirs.logs])
    await assert.rejects(access(path), { code: "ENOENT" });
  await access(f.dirs.data);
});

test("explicit discard removes the private environment including data and preserves shared and other resources", async (t) => {
  const f = await fixture(t);
  const other = await f.resources.ensure("b".repeat(32));
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "outside");
  await symlink(
    outside,
    join(f.dirs.data, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(join(f.dirs.data, "database"), "private");
  await writeFile(join(other.data, "database"), "other");
  await writeFile(join(f.dirs.packageStore, "shared"), "shared");
  await f.resources.discard(id);
  await f.resources.discard(id);
  await assert.rejects(access(join(f.managed, "resources", id)), { code: "ENOENT" });
  assert.equal(await readFile(join(other.data, "database"), "utf8"), "other");
  assert.equal(await readFile(join(f.dirs.packageStore, "shared"), "utf8"), "shared");
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "outside");
});

test("discard validates redirected data before performing any physical deletion", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "outside");
  await rm(f.dirs.data, { recursive: true, force: true });
  await symlink(outside, f.dirs.data, process.platform === "win32" ? "junction" : "dir");
  const targets: string[] = [];
  const resources = createRuntimeResources(f.managed, async (path) => {
    targets.push(path);
  });
  await assert.rejects(resources.discard(id), /managed|symlink|containment/iu);
  assert.deepEqual(targets, []);
  await access(f.dirs.temp);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "outside");
});

test("discard cannot report success when the physical removal port leaves the root behind", async (t) => {
  const f = await fixture(t);
  const resources = createRuntimeResources(f.managed, async () => {});
  await assert.rejects(resources.discard(id), /still exists/iu);
});
