import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { captureGitSnapshot } from "./gitBackupSnapshot.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "git-backup-snapshot-test-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git", "objects"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "fixture HEAD\n");
  await writeFile(join(workspace, ".git", "objects", "fixture"), Buffer.from([0, 255]));
  return { root, workspace };
}

test("snapshot rejects incomplete Git layouts and bounded memory overflow", async () => {
  const f = await fixture();
  try {
    await assert.rejects(captureGitSnapshot(f.workspace, { maxArchiveBytes: 1 }), /memory limit/);
    await assert.rejects(captureGitSnapshot(f.workspace, { maxFiles: 1 }), /file limit/);
    await mkdir(join(f.workspace, ".git", "worktrees"));
    await assert.rejects(captureGitSnapshot(f.workspace), /worktree/);
    await rm(join(f.workspace, ".git", "worktrees"), { recursive: true });
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "fixture"), "not repository data");
    await symlink(outside, join(f.workspace, ".git", "linked"), "junction");
    await assert.rejects(captureGitSnapshot(f.workspace), /symbolic link/);
    await rm(join(f.workspace, ".git", "linked"));
    await mkdir(join(f.workspace, ".git", "objects", "info"));
    await writeFile(
      join(f.workspace, ".git", "objects", "info", "alternates"),
      "fixture-external-path",
    );
    await assert.rejects(captureGitSnapshot(f.workspace), /alternates/);
    await rm(join(f.workspace, ".git"), { recursive: true });
    await symlink(outside, join(f.workspace, ".git"), "junction");
    await assert.rejects(captureGitSnapshot(f.workspace), /symbolic link/);
    await rm(join(f.workspace, ".git"));
    await writeFile(join(f.workspace, ".git"), "gitdir: fixture-external-path");
    await assert.rejects(captureGitSnapshot(f.workspace), /pointer/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("snapshot rejects promisor packs and partial-clone configuration", async () => {
  const f = await fixture();
  const gitDir = join(f.workspace, ".git");
  try {
    await mkdir(join(gitDir, "objects", "pack"));
    const marker = join(gitDir, "objects", "pack", "pack-fixture.promisor");
    await writeFile(marker, "");
    await assert.rejects(captureGitSnapshot(f.workspace), /partial clone/);
    await rm(marker);
    for (const config of [
      '[remote "origin.with.dots"]\n  promisor = true\n',
      "[extensions]\n  partialClone = origin\n",
      "[include]\n  path = ../external-config\n",
    ]) {
      await writeFile(join(gitDir, "config"), config);
      await assert.rejects(captureGitSnapshot(f.workspace), /partial clone/);
    }
    await writeFile(join(gitDir, "config"), "[core]\n  repositoryformatversion = 0\n");
    const snapshot = await captureGitSnapshot(f.workspace);
    assert.ok(snapshot.entries.some((entry) => entry.path === "config"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("snapshot detects concurrent edits and refuses active Git locks", async () => {
  const f = await fixture();
  let writing = true;
  try {
    await writeFile(join(f.workspace, ".git", "index.lock"), "fixture lock");
    await assert.rejects(captureGitSnapshot(f.workspace), /active lock/);
    await rm(join(f.workspace, ".git", "index.lock"));
    for (let i = 0; i < 100; i++)
      await writeFile(
        join(f.workspace, ".git", "objects", `file-${i}`),
        Buffer.alloc(64 * 1024, i),
      );
    const mutate = (async () => {
      let version = 0;
      while (writing) {
        await writeFile(join(f.workspace, ".git", "HEAD"), `fixture version ${version++}\n`);
        await sleep(0);
      }
    })();
    try {
      await assert.rejects(captureGitSnapshot(f.workspace), /changed during snapshot/);
    } finally {
      writing = false;
      await mutate;
    }
  } finally {
    writing = false;
    await rm(f.root, { recursive: true, force: true });
  }
});
