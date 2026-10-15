import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createFsStorageCleaner } from "./adapters/fsCleaner.js";
import { runStorageScan } from "./adapters/inProcessScanRunner.js";
import { createStorageService } from "./app/storageService.js";

test("real scan, clean and rescan retain sources, recent sessions and business data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-storage-clean-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const root = { id: "home" as const, path: directory, hasCustomDataBaseDir: false };
  const files = [
    ["cli/video-cache/old/video.mp4", 10],
    ["cli/image-cache/active/image.png", 10],
    ["cli/artifacts/active/source.json", 0],
    ["cli/artifacts/old/source.json", 10],
    ["editor-icon/old/icon.png", 10],
    ["editor-icon/live/icon.png", 0],
    ["tmp/paste-attachments/original.txt", 10],
    ["v2/worktrees/bindings/one.json", 10],
    ["v2/git-backup/repo.bundle", 10],
    ["v2/runtime-environments/runtime/node.exe", 10],
    ["v2/credentials.json", 10],
  ] as const;
  for (const [path, age] of files) {
    const absolute = join(directory, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "fixture");
    await utimes(absolute, new Date(now - age * day), new Date(now - age * day));
  }
  const scan = () =>
    runStorageScan({ roots: [root], signal: new AbortController().signal, onProgress() {} });
  const before = await scan();
  assert.equal(before.roots[0]?.categories.find((category) => category.id === "other")?.bytes, 0);
  const service = createStorageService({
    roots: { resolveRoots: async () => [root] },
    scanRunner: {
      run: async () => {
        throw new Error("unused");
      },
    },
    cleaner: createFsStorageCleaner(),
    now: () => now,
  });
  t.after(() => service.dispose());
  const media = await service.clean({ rootId: "home", categoryId: "mediaCache" });
  const icons = await service.clean({ rootId: "home", categoryId: "editorCache" });
  assert.equal(media.deletedCount, 1);
  assert.equal(icons.deletedCount, 1);
  assert.deepEqual([...media.failures, ...icons.failures], []);
  for (const [path] of files) {
    if (path === files[0][0] || path === files[4][0])
      await assert.rejects(access(join(directory, path)), { code: "ENOENT" });
    else await access(join(directory, path));
  }
  const after = await scan();
  assert.equal(before.roots[0]!.bytes - after.roots[0]!.bytes, media.freedBytes + icons.freedBytes);
  assert.equal((await service.clean({ rootId: "home", categoryId: "mediaCache" })).deletedCount, 0);
  await access(join(directory, "cli/video-cache"));
  await access(join(directory, "editor-icon"));
});

test("cleaner rejects symlink scope ancestors and rechecks deletion targets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-storage-links-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = resolve(directory, "root");
  const outside = resolve(directory, "outside");
  await mkdir(root);
  await mkdir(join(outside, "video-cache", "session"), { recursive: true });
  await writeFile(join(outside, "video-cache", "session", "file.mp4"), "keep");
  try {
    await symlink(outside, join(root, "cli"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("directory symlink permission unavailable");
    return;
  }
  const cleaner = createFsStorageCleaner();
  assert.deepEqual(
    await cleaner.listCandidates(root, [{ prefix: "cli/video-cache", recursive: true }]),
    [],
  );
  const result = await cleaner.deleteFiles(
    root,
    [{ relativePath: "cli/video-cache/session/file.mp4", bytes: 4, mtimeMs: 0 }],
    { keepDirectories: [] },
  );
  assert.equal(result.deletedCount, 0);
  assert.equal(result.failures.length, 1);
  await access(join(outside, "video-cache/session/file.mp4"));
});
