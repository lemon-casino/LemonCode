import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareProjectMemoryStorage, resolveProjectMemoryRoot } from "./projectMemoryStorage.js";
import { buildRemoteWorkspaceIdentity } from "./remote-workspace-identity.js";

async function fixture(t: { after: (action: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lcode-memory-location-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    workspacePath: join(root, "project with spaces"),
    cliStorageRoot: join(root, "cli"),
  };
  await mkdir(input.workspacePath);
  const profile = resolveProjectMemoryRoot(input);
  const workspace = resolveProjectMemoryRoot({ ...input, storageLocation: "workspace" });
  await mkdir(profile, { recursive: true });
  return { ...input, input, profile, workspace };
}

test("profile remains the default; project location uses actual root and worktrees stay separate", () => {
  const input = { cliStorageRoot: join(tmpdir(), "cli"), workspacePath: join(tmpdir(), "project") };
  assert.equal(
    resolveProjectMemoryRoot(input),
    resolveProjectMemoryRoot({ ...input, storageLocation: "profile" }),
  );
  assert.equal(
    resolveProjectMemoryRoot({ ...input, storageLocation: "workspace" }),
    join(input.workspacePath, ".lcode", "memory"),
  );
  assert.notEqual(
    resolveProjectMemoryRoot({
      ...input,
      workspacePath: join(tmpdir(), "worktree"),
      storageLocation: "workspace",
    }),
    resolveProjectMemoryRoot({ ...input, storageLocation: "workspace" }),
  );
  assert.notEqual(
    resolveProjectMemoryRoot({ ...input, workspaceIdentity: "scope-a" }),
    resolveProjectMemoryRoot({ ...input, workspaceIdentity: "scope-b" }),
  );
  assert.notEqual(
    resolveProjectMemoryRoot({
      ...input,
      workspaceIdentity: "scope-a",
      storageLocation: "workspace",
    }),
    resolveProjectMemoryRoot({
      ...input,
      workspaceIdentity: "scope-b",
      storageLocation: "workspace",
    }),
  );
});

test("initial profile initialization does not import or create project memory", async (t) => {
  const h = await fixture(t);
  const result = await prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile" });
  assert.deepEqual(result, { rootDir: h.profile, copiedCount: 0, conflictCount: 0 });
  assert.deepEqual(await readdir(h.workspacePath), []);
});

test("switch copies recursive topics and index only, preserving source and target conflicts", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.profile, "nested"));
  await writeFile(join(h.profile, "MEMORY.md"), "- [Fact](nested/fact.md)");
  await writeFile(join(h.profile, "nested", "fact.md"), "durable fixture");
  await writeFile(join(h.profile, "conflict.md"), "source");
  await writeFile(join(h.profile, "ignored.json"), "not a memory");
  await mkdir(join(dirname(h.profile), "memory-state"));
  await writeFile(join(dirname(h.profile), "memory-state", "owner.json"), "source owner");
  await mkdir(h.workspace, { recursive: true });
  await writeFile(join(h.workspace, "conflict.md"), "target");
  assert.deepEqual(
    await prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" }),
    { rootDir: h.workspace, copiedCount: 2, conflictCount: 1 },
  );
  assert.equal(await readFile(join(h.workspace, "nested", "fact.md"), "utf8"), "durable fixture");
  assert.equal(await readFile(join(h.workspace, "conflict.md"), "utf8"), "target");
  assert.equal(await readFile(join(h.profile, "nested", "fact.md"), "utf8"), "durable fixture");
  assert.deepEqual(await readdir(join(dirname(h.workspace), "memory-state")), []);
});

test("prepared location never reimports a deleted target; switching back imports new files", async (t) => {
  const h = await fixture(t);
  await writeFile(join(h.profile, "old.md"), "old");
  await prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" });
  await rm(join(h.workspace, "old.md"));
  const repeat = await prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" });
  assert.equal(repeat.copiedCount, 0);
  assert.deepEqual(await readdir(h.workspace), []);
  await writeFile(join(h.workspace, "new.md"), "new");
  assert.equal(
    (
      await prepareProjectMemoryStorage({
        ...h.input,
        storageLocation: "profile",
        previousStorageLocation: "workspace",
      })
    ).copiedCount,
    1,
  );
  assert.equal(await readFile(join(h.profile, "new.md"), "utf8"), "new");
});

test("concurrent preparations serialize using the writer roots and do not duplicate import", async (t) => {
  const h = await fixture(t);
  await writeFile(join(h.profile, "fact.md"), "fact");
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" }),
    ),
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.copiedCount, 0),
    1,
  );
  assert.equal(await readFile(join(h.workspace, "fact.md"), "utf8"), "fact");
});

test("invalid location, remote project mode and UNC paths reject before directory creation", async (t) => {
  const h = await fixture(t);
  assert.throws(() =>
    resolveProjectMemoryRoot({ ...h.input, storageLocation: "other" as "workspace" }),
  );
  assert.throws(() =>
    resolveProjectMemoryRoot({
      ...h.input,
      workspaceIdentity: buildRemoteWorkspaceIdentity("/project", {
        kind: "ssh",
        host: "fixture.invalid",
        username: "fixture",
      }),
      storageLocation: "workspace",
    }),
  );
  await assert.rejects(
    prepareProjectMemoryStorage({
      ...h.input,
      workspacePath: "\\\\server\\share\\project",
      storageLocation: "workspace",
    }),
  );
  assert.deepEqual(await readdir(h.workspacePath), []);
});

test("symlink or junction directories cannot redirect a project location", async (t) => {
  const h = await fixture(t);
  const outside = join(dirname(h.workspacePath), "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(h.workspacePath, ".lcode"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" }));
  assert.deepEqual(await readdir(outside), []);
});

test("copy budget rejects before creating any target file or committing a marker", async (t) => {
  const h = await fixture(t);
  await writeFile(join(h.profile, "huge.md"), Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" }));
  assert.deepEqual(await readdir(h.workspace), []);
  await assert.rejects(readFile(join(dirname(h.profile), "storage-location.json")), {
    code: "ENOENT",
  });
});

test("same-path identities migrate into distinct project roots without exposing other files", async (t) => {
  const h = await fixture(t);
  for (const workspaceIdentity of ["identity-a", "identity-b"]) {
    const input = { ...h.input, workspaceIdentity };
    const profile = resolveProjectMemoryRoot(input);
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, `${workspaceIdentity}.md`), workspaceIdentity);
    const result = await prepareProjectMemoryStorage({ ...input, storageLocation: "workspace" });
    assert.deepEqual(await readdir(result.rootDir), [`${workspaceIdentity}.md`]);
  }
});

test("a writer lock junction is rejected before touching its external lock owner", async (t) => {
  const h = await fixture(t);
  const state = join(dirname(h.profile), "memory-state");
  const outside = join(dirname(h.workspacePath), "external-lock");
  await mkdir(state);
  await mkdir(outside);
  await writeFile(join(outside, "owner.json"), "fixture-owner");
  await symlink(
    outside,
    join(state, "writer.lock"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" }));
  assert.equal(await readFile(join(outside, "owner.json"), "utf8"), "fixture-owner");
});

test("a failed setting commit can return to profile without deleting copied files", async (t) => {
  const h = await fixture(t);
  await writeFile(join(h.profile, "source.md"), "retained");
  await prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" });
  await writeFile(join(h.workspace, "later.md"), "target-side change");
  const restored = await prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile" });
  assert.equal(restored.copiedCount, 1);
  assert.equal(await readFile(join(h.workspace, "source.md"), "utf8"), "retained");
  assert.equal(await readFile(join(h.profile, "later.md"), "utf8"), "target-side change");
});

test("explicit setting retry imports new old-location facts despite a prepared target marker", async (t) => {
  const h = await fixture(t);
  const change = {
    ...h.input,
    storageLocation: "workspace" as const,
    previousStorageLocation: "profile" as const,
  };
  await writeFile(join(h.profile, "first.md"), "first");
  await prepareProjectMemoryStorage(change);
  // 模拟copies完成后setting.update失败，原profile仍是权威且继续产生文件。
  await writeFile(join(h.profile, "later.md"), "later");
  assert.equal((await prepareProjectMemoryStorage(change)).copiedCount, 1);
  assert.equal(await readFile(join(h.workspace, "later.md"), "utf8"), "later");
  await rm(join(h.workspace, "first.md"));
  assert.equal(
    (
      await prepareProjectMemoryStorage({
        ...h.input,
        storageLocation: "workspace",
        previousStorageLocation: "workspace",
      })
    ).copiedCount,
    0,
  );
  await assert.rejects(readFile(join(h.workspace, "first.md")), { code: "ENOENT" });
});

test("older Runtime selections never reverse-copy, roll back a newer marker or resurrect removed files", async (t) => {
  for (const original of ["profile", "workspace"] as const) {
    const h = await fixture(t);
    const newer = original === "profile" ? "workspace" : "profile";
    const old = await prepareProjectMemoryStorage({
      ...h.input,
      storageLocation: original,
      storageRevision: 4,
    });
    await writeFile(join(old.rootDir, "retained.md"), "retained source");
    const selected = await prepareProjectMemoryStorage({
      ...h.input,
      storageLocation: newer,
      storageRevision: 5,
      previousStorageLocation: original,
    });
    const markerPath = join(dirname(h.profile), "storage-location.json");
    const marker = await readFile(markerPath, "utf8");
    await rm(join(selected.rootDir, "retained.md"));
    await writeFile(join(selected.rootDir, "new-position.md"), "only new position");
    assert.deepEqual(
      await prepareProjectMemoryStorage({
        ...h.input,
        storageLocation: original,
        storageRevision: 4,
      }),
      { rootDir: old.rootDir, copiedCount: 0, conflictCount: 0 },
    );
    assert.equal(await readFile(markerPath, "utf8"), marker);
    await assert.rejects(readFile(join(old.rootDir, "new-position.md")), { code: "ENOENT" });
    await prepareProjectMemoryStorage({ ...h.input, storageLocation: newer, storageRevision: 5 });
    await assert.rejects(readFile(join(selected.rootDir, "retained.md")), { code: "ENOENT" });
  }
});

test("newer delayed projects migrate, equal-revision opposite locations and stale commands reject", async (t) => {
  const h = await fixture(t);
  await prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile", storageRevision: 0 });
  await writeFile(join(h.profile, "later.md"), "later project");
  assert.equal(
    (
      await prepareProjectMemoryStorage({
        ...h.input,
        storageLocation: "workspace",
        storageRevision: 3,
      })
    ).copiedCount,
    1,
  );
  await assert.rejects(
    prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile", storageRevision: 3 }),
    { code: "revision_conflict" },
  );
  await assert.rejects(
    prepareProjectMemoryStorage({
      ...h.input,
      storageLocation: "profile",
      storageRevision: 2,
      previousStorageLocation: "workspace",
    }),
    { code: "revision_conflict" },
  );
  await writeFile(
    join(h.profile, "retry.md"),
    "old authoritative position during failed setting commit",
  );
  assert.equal(
    (
      await prepareProjectMemoryStorage({
        ...h.input,
        storageLocation: "workspace",
        storageRevision: 3,
        previousStorageLocation: "profile",
      })
    ).copiedCount,
    1,
  );
});

test("legacy CLI migration remains compatible but cannot overwrite a versioned desktop marker", async (t) => {
  const h = await fixture(t);
  await prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile" });
  const markerPath = join(dirname(h.profile), "storage-location.json");
  assert.equal(JSON.parse(await readFile(markerPath, "utf8")).schemaVersion, 1);
  await writeFile(join(h.profile, "legacy.md"), "legacy fixture");
  assert.equal(
    (await prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" })).copiedCount,
    1,
  );
  await prepareProjectMemoryStorage({
    ...h.input,
    storageLocation: "workspace",
    storageRevision: 1,
  });
  const marker = await readFile(markerPath, "utf8");
  assert.equal(JSON.parse(marker).schemaVersion, 2);
  await writeFile(join(h.workspace, "desktop.md"), "desktop scope");
  assert.equal(
    (await prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile" })).copiedCount,
    0,
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
  await assert.rejects(readFile(join(h.profile, "desktop.md")), { code: "ENOENT" });
  for (const storageRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
    await assert.rejects(
      prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace", storageRevision }),
    );
});

test("unversioned CLI can use its chosen root without changing desktop revision zero", async (t) => {
  const h = await fixture(t);
  await prepareProjectMemoryStorage({ ...h.input, storageLocation: "profile", storageRevision: 0 });
  await writeFile(join(h.profile, "desktop.md"), "desktop zero");
  const markerPath = join(dirname(h.profile), "storage-location.json");
  const marker = await readFile(markerPath, "utf8");
  assert.deepEqual(
    await prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace" }),
    { rootDir: h.workspace, copiedCount: 0, conflictCount: 0 },
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
  await assert.rejects(readFile(join(h.workspace, "desktop.md")), { code: "ENOENT" });
  await assert.rejects(
    prepareProjectMemoryStorage({
      ...h.input,
      storageLocation: "workspace",
      previousStorageLocation: "profile",
    }),
    { code: "revision_conflict" },
  );
  await assert.rejects(
    prepareProjectMemoryStorage({ ...h.input, storageLocation: "workspace", storageRevision: 0 }),
    { code: "revision_conflict" },
  );
});
