import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, link, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";

export class ProjectMemoryStorageError extends Error {
  constructor(
    readonly code:
      | "invalid_path"
      | "unsupported_scope"
      | "budget_exceeded"
      | "invalid_marker"
      | "revision_conflict",
  ) {
    super(
      {
        invalid_path: "Memory storage requires safe local directories and regular Markdown files.",
        unsupported_scope:
          "Project-local memory storage is not supported for remote workspace identities.",
        budget_exceeded: "Memory storage copy exceeds its bounded file or byte budget.",
        invalid_marker:
          "Memory storage location metadata is invalid or belongs to a different workspace.",
        revision_conflict: "Memory storage location revision conflicts with the prepared location.",
      }[code],
    );
    this.name = "ProjectMemoryStorageError";
  }
}

export const memoryStorageErrorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export function localMemoryStoragePath(path: string): string {
  if (
    !isAbsolute(path) ||
    /^[\\/]{2}/u.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path.split(/[\\/]/u).some((part) => part === "." || part === "..")
  )
    throw new ProjectMemoryStorageError("invalid_path");
  return normalize(path);
}

export class MemoryStorageDirectories {
  private readonly pins = new Map<string, { dev: number; ino: number }>();

  async check(path: string, create = false): Promise<void> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (memoryStorageErrorCode(error) !== "ENOENT" || !create || this.pins.has(path)) throw error;
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (mkdirError) {
        if (memoryStorageErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      info = await lstat(path);
    }
    const pinned = this.pins.get(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      relative(await realpath(path), path) !== "" ||
      (pinned && (pinned.dev !== info.dev || pinned.ino !== info.ino))
    )
      throw new ProjectMemoryStorageError("invalid_path");
    this.pins.set(path, { dev: info.dev, ino: info.ino });
  }

  async chain(path: string, create = false): Promise<void> {
    path = localMemoryStoragePath(path);
    let current = parse(path).root;
    await this.check(current);
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      await this.check(current, create);
    }
  }

  async validate(): Promise<void> {
    for (const path of this.pins.keys()) await this.check(path);
  }
}

export async function readMemoryStorageFile(
  path: string,
  maxBytes: number,
  directories: MemoryStorageDirectories,
): Promise<Buffer | undefined> {
  await directories.chain(dirname(path));
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (memoryStorageErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || relative(await realpath(path), path) !== "")
    throw new ProjectMemoryStorageError("invalid_path");
  if (before.size > maxBytes) throw new ProjectMemoryStorageError("budget_exceeded");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.size !== opened.size ||
      before.mtimeMs !== opened.mtimeMs ||
      before.ctimeMs !== opened.ctimeMs ||
      opened.size > maxBytes
    )
      throw new ProjectMemoryStorageError("invalid_path");
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, null);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      size > maxBytes ||
      size !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new ProjectMemoryStorageError("invalid_path");
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs
    )
      throw new ProjectMemoryStorageError("invalid_path");
    await directories.validate();
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

export async function publishMemoryStorageFile(
  path: string,
  content: Buffer,
  directories: MemoryStorageDirectories,
  replace = false,
): Promise<boolean> {
  await directories.chain(dirname(path), true);
  await directories.validate();
  const temporary = join(dirname(path), `.lcode-memory-location-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // 原因：普通 rename 会覆盖并发生成的目标；完整临时文件以排他 link 发布，冲突保留目标。
    await directories.validate();
    try {
      if (replace) await rename(temporary, path);
      else await link(temporary, path);
    } catch (error) {
      if (memoryStorageErrorCode(error) === "EEXIST") return false;
      throw error;
    }
    await directories.validate();
    return true;
  } finally {
    await directories.validate();
    await rm(temporary, { force: true });
  }
}
