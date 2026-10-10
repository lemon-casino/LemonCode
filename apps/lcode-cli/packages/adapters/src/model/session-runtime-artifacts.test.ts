import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, access, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteSessionRuntimeArtifacts } from "./session-runtime-artifacts.js";

test("permanent cleanup removes exact private session directories and preserves shared data", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-artifacts-"));
  try {
    for (const kind of ["agents", "artifacts", "exec"])
      for (const id of ["sess_removed", "sess_kept"]) {
        await mkdir(join(root, kind, id), { recursive: true });
        await writeFile(join(root, kind, id, "private.txt"), "fixture");
      }
    await mkdir(join(root, "image-cache"));
    await writeFile(join(root, "image-cache", "shared"), "fixture");
    await deleteSessionRuntimeArtifacts(["sess_removed"], root);
    await deleteSessionRuntimeArtifacts(["sess_removed"], root);
    for (const kind of ["agents", "artifacts", "exec"]) {
      await assert.rejects(access(join(root, kind, "sess_removed")));
      await access(join(root, kind, "sess_kept", "private.txt"));
    }
    await access(join(root, "image-cache", "shared"));
    await assert.rejects(deleteSessionRuntimeArtifacts(["../sess_kept"], root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redirected private target rejects before removing any other target", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-artifacts-link-"));
  const outside = await mkdtemp(join(tmpdir(), "session-artifacts-outside-"));
  try {
    await mkdir(join(root, "agents", "sess_removed"), { recursive: true });
    await mkdir(join(root, "artifacts"));
    await writeFile(join(outside, "keep.txt"), "fixture");
    await symlink(
      outside,
      join(root, "artifacts", "sess_removed"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      deleteSessionRuntimeArtifacts(["sess_removed"], root),
      /redirected|symlink/u,
    );
    await access(join(root, "agents", "sess_removed"));
    await access(join(outside, "keep.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
