import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createGitCommandProvider } from "../git/node.js";
import type { GitBackupManifestEntry } from "./gitBackup.js";

export interface GitBackupSnapshotOptions {
  maxArchiveBytes?: number;
  maxFiles?: number;
}

interface FileStamp {
  path: string;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  directory: boolean;
}

function stamp(path: string, stats: Stats): FileStamp {
  return {
    path,
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    directory: stats.isDirectory(),
  };
}

async function inventory(gitDir: string, maxFiles: number): Promise<FileStamp[]> {
  const result: FileStamp[] = [];
  let count = 0;
  async function walk(path: string): Promise<void> {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      throw new Error("Unsupported Git symbolic link; refusing to follow repository-external data");
    if (!stats.isDirectory() && !stats.isFile()) throw new Error("Unsupported special Git file");
    const relPath = relative(gitDir, path);
    if (
      relPath === "worktrees" ||
      relPath.replaceAll("\\", "/").split("/").at(-1) === "commondir" ||
      relPath.replaceAll("\\", "/").endsWith("objects/info/alternates") ||
      relPath.replaceAll("\\", "/").endsWith("objects/info/http-alternates")
    ) {
      throw new Error(
        "Unsupported linked worktree or object alternates; a complete backup cannot be guaranteed",
      );
    }
    if (stats.isFile() && relPath.endsWith(".promisor"))
      throw new Error("Unsupported partial clone; remote-promised objects are not backed up");
    if (stats.isFile() && relPath.endsWith(".lock"))
      throw new Error("Git repository has an active lock file; retry when idle");
    result.push(stamp(relPath, stats));
    if (!stats.isDirectory()) {
      if (++count > maxFiles) throw new Error("Git backup exceeds file limit");
      return;
    }
    for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  await walk(gitDir);
  return result;
}

const gitCommands = createGitCommandProvider();

async function rejectPartialCloneConfig(gitDir: string): Promise<void> {
  // promisor 即使尚无 pack 标记也可能缺对象；让 Git 解析配置，禁止 include 读取仓库外文件。
  const result = await gitCommands.run({
    cwd: gitDir,
    args: [
      "config",
      "--file",
      join(gitDir, "config"),
      "--no-includes",
      "--null",
      "--name-only",
      "--get-regexp",
      String.raw`^(extensions\.partialclone|remote\..*\.promisor|include\.path|includeif\..*\.path)$`,
    ],
    maxOutputBytes: 64 * 1024,
  });
  if (result.timedOut || result.outputTruncated || ![0, 1].includes(result.exitCode ?? -1))
    throw new Error("Cannot validate Git repository configuration");
  if (result.stdout) {
    throw new Error(
      "Unsupported partial clone or external Git configuration; a complete backup cannot be guaranteed",
    );
  }
}

export async function captureGitSnapshot(
  workspacePath: string,
  options: GitBackupSnapshotOptions = {},
): Promise<{ packed: Buffer; entries: GitBackupManifestEntry[] }> {
  const workspaceStats = await lstat(workspacePath);
  if (workspaceStats.isSymbolicLink())
    throw new Error(
      "Unsupported workspace symbolic link; refusing to follow repository-external data",
    );
  // macOS /var 等父级系统别名是正常路径；以解析后的工作区为边界，不拒绝系统别名。
  const gitDir = resolve(await realpath(workspacePath), ".git");
  let root: Stats;
  try {
    root = await lstat(gitDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("No .git directory found in the workspace");
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(
      "Unsupported .git pointer, worktree, submodule, or symbolic link; requires a complete Git-directory backup",
    );
  }
  const canonicalRoot = await realpath(gitDir);
  const maxBytes = options.maxArchiveBytes ?? 256 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 100_000;
  const before = await inventory(gitDir, maxFiles);
  if (before.some((file) => file.path === "config" && !file.directory))
    await rejectPartialCloneConfig(gitDir);
  const chunks: Buffer[] = [];
  const entries: GitBackupManifestEntry[] = [];
  let packedSize = 0;
  // 原来的清单扫描与打包会重复读文件，Git 并发写入时哈希和归档字节不一致。
  for (const file of before.filter((item) => !item.directory)) {
    const fullPath = join(gitDir, file.path);
    const header = Buffer.from(`${file.path}\0${file.size}\0`);
    packedSize += header.length + file.size;
    if (packedSize > maxBytes) throw new Error("Git backup exceeds archive memory limit");
    if ((await realpath(fullPath)) !== join(canonicalRoot, file.path))
      throw new Error("Git snapshot path changed during capture");
    const handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (JSON.stringify(stamp(file.path, await handle.stat())) !== JSON.stringify(file))
        throw new Error("Git file changed during snapshot");
      const content = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
        if (!bytesRead) throw new Error("Git file changed during snapshot (short read)");
        offset += bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (
        extra.bytesRead ||
        JSON.stringify(stamp(file.path, await handle.stat())) !== JSON.stringify(file)
      )
        throw new Error("Git file changed during snapshot");
      chunks.push(header, content);
      entries.push({
        path: file.path,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  // 文件增加、删除、替换及目录变化都必须使快照失败，不能把混合时间点报告成成功。
  if (JSON.stringify(before) !== JSON.stringify(await inventory(gitDir, maxFiles)))
    throw new Error("Git repository changed during snapshot; retry when idle");
  return { packed: Buffer.concat(chunks, packedSize), entries };
}
