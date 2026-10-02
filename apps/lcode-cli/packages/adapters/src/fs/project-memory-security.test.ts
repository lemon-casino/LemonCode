import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_RECORD_LIMIT,
  PROJECT_MEMORY_RECORD_MAX_BYTES,
} from "@lcode/contracts";
import { NodeFileSystemAdapter } from "./index.js";
import { MemoryRootRegistry, prepareMemoryRoot } from "./project-memory-paths.js";
import { hasCode, memoryFixture, reviewDraft } from "./project-memory.test-support.js";

test("registered control storage refuses ordinary FS writes, removal and mkdir", async (t) => {
  const { stateDir, rootDir, adapter } = await memoryFixture(t);
  for (const path of [join(stateDir, "forged.json"), join(stateDir, "reviews", "forged.json")]) {
    await assert.rejects(
      adapter.writeTextFile({ path, content: "forged" }),
      hasCode("invalid_path"),
    );
    await assert.rejects(adapter.removeFile({ path, missingOk: true }), hasCode("invalid_path"));
    await assert.rejects(adapter.createDirectory({ path }), hasCode("invalid_path"));
  }
  const path = join(rootDir, "fact.md");
  await adapter.writeTextFile({ path, content: "retain", expectedMissing: true });
  await assert.rejects(adapter.removeFile({ path }), hasCode("unsupported"));
  assert.equal(await readFile(path, "utf8"), "retain");
  const alias = join(rootDir, "state-alias");
  await symlink(stateDir, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    adapter.writeTextFile({ path: join(alias, "owner.json"), content: "forged" }),
    hasCode("invalid_path"),
  );
});

test("registered paths reject lexical escape and UNC root registration without contacting a share", async (t) => {
  const { rootDir, adapter, memory } = await memoryFixture(t);
  await assert.rejects(
    adapter.writeTextFile({
      path: `${rootDir}/../outside.md`,
      content: "escape",
      expectedMissing: true,
    }),
    hasCode("invalid_path"),
  );
  for (const fileName of [
    "../escape.md",
    "/absolute.md",
    "nested/../../escape.md",
    "C:/escape.md",
    "nested\\escape.md",
  ]) {
    const draft = reviewDraft();
    draft.items[0]!.fileName = fileName;
    await assert.rejects(memory.saveReview({ rootDir, draft }));
  }
  await assert.rejects(
    memory.registerRoot("\\\\fixture.invalid\\share\\memory"),
    hasCode("invalid_path"),
  );
  await assert.rejects(
    memory.registerRoot("//fixture.invalid/share/memory"),
    hasCode("invalid_path"),
  );
  for (const path of [
    join(rootDir, "fact.md "),
    join(rootDir, "fact.md:hidden"),
    `\\\\?\\${rootDir}\\fact.md`,
  ]) {
    await assert.rejects(
      adapter.writeTextFile({ path, content: "alias escape" }),
      hasCode("invalid_path"),
    );
  }
});

test("local memory registration leaves external UNC routing untouched but rejects device aliases", async (t) => {
  const { rootDir } = await memoryFixture(t);
  const root = await prepareMemoryRoot(rootDir);
  const registry = new MemoryRootRegistry();
  registry.roots.set(root.rootDir, root);
  // 仅验证路由不触网；普通共享盘交回原 FS/权限，不按 memory 安全策略全局拒绝。
  for (const path of [
    "\\\\fixture.invalid\\share\\unrelated.txt",
    "//fixture.invalid/share/unrelated.md",
  ]) {
    assert.equal(await registry.route(path), undefined);
  }
  for (const prefix of ["\\\\?\\", "\\\\.\\", "//?/", "//./"]) {
    await assert.rejects(registry.route(`${prefix}${rootDir}/fact.md`), hasCode("invalid_path"));
  }
});

test("root, root ancestors, target parents and state junction swaps fail closed", async (t) => {
  const { base, rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "fact.md"), "external");
  const link = join(rootDir, "linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    adapter.writeTextFile({
      path: join(link, "fact.md"),
      content: "escape",
      expectedMissing: true,
    }),
    hasCode("invalid_path"),
  );
  const rootLink = join(base, "root-alias");
  await symlink(rootDir, rootLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    new NodeFileSystemAdapter().projectMemory.registerRoot(rootLink),
    hasCode("invalid_path"),
  );
  await assert.rejects(
    new NodeFileSystemAdapter().projectMemory.registerRoot(join(rootLink, "child")),
    hasCode("invalid_path"),
  );
  await assert.rejects(
    adapter.writeTextFile({
      path: join(rootLink, "aliased.md"),
      content: "escape",
      expectedMissing: true,
    }),
    hasCode("invalid_path"),
  );
  await rename(stateDir, `${stateDir}-original`);
  await symlink(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(memory.listChanges(rootDir), hasCode("invalid_path"));
  await assert.rejects(
    adapter.writeTextFile({ path: join(rootDir, "ordinary.txt"), content: "must fail closed" }),
    hasCode("invalid_path"),
  );
  await rm(stateDir);
  await rename(`${stateDir}-original`, stateDir);
  await rename(rootDir, `${rootDir}-original`);
  await symlink(outside, rootDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    adapter.writeTextFile({
      path: join(rootDir, "fact.md"),
      content: "escape",
      expectedMissing: true,
    }),
    hasCode("invalid_path"),
  );
  assert.equal(await readFile(join(outside, "fact.md"), "utf8"), "external");
});

test("a parent directory replaced after registration cannot redirect the sidecar", async (t) => {
  const { base, rootDir, adapter } = await memoryFixture(t);
  const displaced = `${base}-original`;
  const other = `${base}-external`;
  t.after(async () => {
    await rm(base, { force: true, recursive: true });
    await rm(displaced, { force: true, recursive: true });
    await rm(other, { force: true, recursive: true });
  });
  await mkdir(other);
  await rename(base, displaced);
  await symlink(other, base, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    adapter.writeTextFile({
      path: join(rootDir, "fact.md"),
      content: "escape",
      expectedMissing: true,
    }),
    hasCode("invalid_path"),
  );
  assert.deepEqual(await readdir(other), []);
});

test("memory and record size budgets reject instead of truncating or deleting records", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "fact.md");
  await assert.rejects(
    adapter.writeTextFile({
      path,
      content: "x".repeat(PROJECT_MEMORY_FILE_MAX_BYTES + 1),
      expectedMissing: true,
    }),
    hasCode("too_large"),
  );
  for (let index = 0; index < PROJECT_MEMORY_RECORD_LIMIT; index += 1) {
    const id = `record-${String(index).padStart(4, "0")}`;
    const review = {
      schemaVersion: 1,
      id,
      createdAt: index,
      revision: 1,
      draft: reviewDraft(),
      appliedItems: {},
    };
    await writeFile(
      join(stateDir, "reviews", `${id}.json`),
      JSON.stringify({ schemaVersion: 1, rootDir, review }),
      { mode: 0o600 },
    );
  }
  await assert.rejects(memory.saveReview({ rootDir, draft: reviewDraft() }), hasCode("too_large"));
  assert.equal((await memory.listReviews(rootDir)).length, PROJECT_MEMORY_RECORD_LIMIT);
  const oversized = join(stateDir, "reviews", "record-0000.json");
  await writeFile(oversized, "x".repeat(PROJECT_MEMORY_RECORD_MAX_BYTES + 1));
  await assert.rejects(memory.listReviews(rootDir), hasCode("too_large"));
  assert.equal((await readdir(join(stateDir, "reviews"))).length, PROJECT_MEMORY_RECORD_LIMIT);
});

test("private sidecars use 0600 on systems with POSIX mode enforcement", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "fact.md");
  const written = await adapter.writeTextFile({ path, content: "old", expectedMissing: true });
  await adapter.writeTextFile({ path, content: "new", expectedRevision: written.revision });
  await memory.saveReview({ rootDir, draft: reviewDraft() });
  if (process.platform === "win32") {
    t.diagnostic(
      "Windows mode bits do not prove ACL privacy; 0600 is requested for all sidecar writes",
    );
    return;
  }
  for (const directory of ["journal", "preimages", "reviews"]) {
    for (const file of await readdir(join(stateDir, directory)))
      assert.equal((await stat(join(stateDir, directory, file))).mode & 0o777, 0o600);
  }
});
