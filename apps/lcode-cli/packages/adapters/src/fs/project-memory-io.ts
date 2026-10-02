import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFileSystemError, PROJECT_MEMORY_RECORD_LIMIT } from "@lcode/contracts";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";
import { getNodeErrorCode, throwIfAborted } from "./file-system-common.js";

export const MEMORY_TEMP_PREFIX = ".lcode-memory-";
const PRIVATE_FILE_MODE = 0o600;

export function memoryError(
  code: Parameters<typeof createFileSystemError>[0]["code"],
  path: string,
  message: string,
): Error {
  return createFileSystemError({ code, path, message });
}

export async function readMemoryBytes(
  path: string,
  maxBytes: number,
  missingOk = false,
): Promise<Buffer | null> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (missingOk && getNodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw memoryError("invalid_path", path, "Project Memory accepts regular files only");
  }
  if (initial.size > maxBytes)
    throw memoryError("too_large", path, "Project Memory file exceeds its byte budget");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw memoryError("invalid_path", path, "Project Memory file changed while opening");
    }
    // stat 后仍可能增长；只分配上限加一字节，短读不当成 EOF。
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(opened.size + 1, 1)));
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = total === 0 ? buffer : Buffer.alloc(Math.min(maxBytes + 1 - total, 64 * 1024));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes)
      throw memoryError("too_large", path, "Project Memory file exceeds its byte budget");
    const current = await lstat(path);
    const final = await handle.stat();
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw memoryError("invalid_path", path, "Project Memory file was replaced while reading");
    }
    if (
      final.size !== total ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw memoryError("stale_write", path, "Project Memory file changed while reading");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function listMemoryFiles(
  directory: string,
  maxBytes: number,
): Promise<Map<string, number>> {
  const entries = new Map<string, number>();
  const dir = await opendir(directory);
  for await (const entry of dir) {
    if (entries.size >= PROJECT_MEMORY_RECORD_LIMIT) {
      throw memoryError(
        "too_large",
        directory,
        "Project Memory storage is full; no records were deleted",
      );
    }
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw memoryError("invalid_path", path, "Project Memory sidecar must be a regular file");
    }
    if (info.size > maxBytes)
      throw memoryError("too_large", path, "Project Memory sidecar exceeds its byte budget");
    entries.set(entry.name, info.size);
  }
  return entries;
}

export interface StrictAtomicWriteOptions {
  expectedMissing?: boolean;
  mode?: number;
  signal?: AbortSignal;
  validate?: () => Promise<void>;
  beforePublish?: () => Promise<void>;
  onPublished?: () => void;
  onStaged?: (mtimeMs: number) => void;
  tempDirectory?: string;
}

export async function strictAtomicWrite(
  path: string,
  content: Buffer,
  options: StrictAtomicWriteOptions = {},
): Promise<void> {
  const validate = options.validate ?? (async () => {});
  throwIfAborted(options.signal);
  await validate();
  const tempPath = join(
    options.tempDirectory ?? dirname(path),
    `${MEMORY_TEMP_PREFIX}${randomUUID()}.tmp`,
  );
  let staged = false;
  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      options.mode ?? PRIVATE_FILE_MODE,
    );
    staged = true;
    try {
      maybeThrowStorageFsFault({ operation: "writeFile", path });
      await handle.writeFile(content);
      // 私密前像/提案不能沿用旧文件的宽松权限。
      if (options.mode !== undefined) await handle.chmod(options.mode);
      await handle.sync();
      options.onStaged?.((await handle.stat()).mtimeMs);
    } finally {
      await handle.close();
    }
    await validate();
    await options.beforePublish?.();
    await validate();
    throwIfAborted(options.signal);
    if (options.expectedMissing) {
      try {
        // rename 会覆盖竞态中新建的目标；link 发布完整临时文件且原子拒绝 EEXIST。
        await link(tempPath, path);
      } catch (error) {
        if (getNodeErrorCode(error) === "EEXIST")
          throw memoryError("stale_write", path, "Project Memory target is no longer missing");
        throw error;
      }
    } else {
      maybeThrowStorageFsFault({ operation: "rename", path });
      await rename(tempPath, path);
    }
    options.onPublished?.();
    // Windows 文件占用导致 rename 失败时必须保留旧版，绝不降级为 O_TRUNC。
    if (process.platform !== "win32") {
      const directory = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    if (staged) {
      // 只清理本次随机临时文件；边界已变化时宁可留下有界残留，不触碰新目录。
      await validate()
        .then(() => unlink(tempPath))
        .catch(() => undefined);
    }
  }
}
