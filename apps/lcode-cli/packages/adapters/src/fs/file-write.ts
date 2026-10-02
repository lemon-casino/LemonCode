import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createFileSystemError,
  isFileSystemPortError,
  type FileSystemOperationOptions,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemRevision,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@lcode/contracts";
import { applyRequestedLineEndings, encodeTextContent } from "./text-metadata.js";
import { strictAtomicWrite } from "./project-memory-io.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";
import {
  getNodeErrorCode,
  hashBuffer,
  resolveAbsoluteRequestPath,
  revisionId,
  throwIfAborted,
  toFileSystemError,
} from "./file-system-common.js";

export async function writeTextFile(
  request: FileSystemWriteTextRequest,
  options: FileSystemOperationOptions = {},
): Promise<FileSystemWriteTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const encoding = request.encoding ?? "utf8";
  const textContent = applyRequestedLineEndings(request.content, request.lineEndings);
  const content = encodeTextContent({ content: textContent, encoding, path });

  try {
    throwIfAborted(options.signal ?? options.context?.abortSignal);
    if (request.expectedMissing && request.expectedRevision) {
      throw createFileSystemError({
        code: "stale_write",
        path,
        message: "expectedMissing and expectedRevision are mutually exclusive",
      });
    }
    if (request.expectedRevision) {
      await assertExpectedRevision(path, request.expectedRevision);
    }

    if (request.createParents) {
      maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(path) });
      await mkdir(dirname(path), { recursive: true });
    }

    if (request.expectedMissing) {
      // 新字段即使在根外也必须排他发布；旧调用保持原有 atomic/非 atomic 语义。
      await strictAtomicWrite(path, content, {
        expectedMissing: true,
        mode: 0o666,
        signal: options.signal ?? options.context?.abortSignal,
      });
    } else if (request.atomic ?? true) {
      await atomicWrite(path, content);
    } else {
      maybeThrowStorageFsFault({ operation: "writeFile", path });
      await writeFile(path, content);
    }

    const info = await stat(path);
    return {
      path,
      bytesWritten: content.byteLength,
      revision: {
        id: revisionId(info.mtimeMs, info.size),
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        hash: hashBuffer(content),
      },
    };
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

export async function removeFile(
  request: FileSystemRemoveFileRequest,
  options?: { signal?: AbortSignal },
): Promise<FileSystemRemoveFileResult> {
  const path = resolveAbsoluteRequestPath(request.path);

  try {
    throwIfAborted(options?.signal);
    maybeThrowStorageFsFault({ operation: "rm", path });
    await unlink(path);
    return { path, removed: true };
  } catch (error) {
    const normalized = toFileSystemError(error, path);
    if (
      request.missingOk === true &&
      isFileSystemPortError(normalized) &&
      normalized.code === "not_found"
    ) {
      return { path, removed: false };
    }
    throw normalized;
  }
}

async function assertExpectedRevision(path: string, expected: FileSystemRevision): Promise<void> {
  const info = await stat(path);
  const actual = revisionId(info.mtimeMs, info.size);
  if (actual !== expected.id) {
    throw createFileSystemError({
      code: "stale_write",
      path,
      message: `File changed since it was read: ${path}`,
    });
  }
}

class SymlinkWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkWriteRefusedError";
  }
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  let existingMode: number | undefined;

  try {
    const targetInfo = await lstat(path);
    if (targetInfo.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${path}. Resolve the symlink and pass the real target path explicitly.`,
      );
    }
    existingMode = targetInfo.mode;
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;

  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(content);
      if (existingMode !== undefined) {
        // 原子写会用临时文件 inode 覆盖目标文件；必须先复制原文件权限，避免抹掉脚本执行位。
        await handle.chmod(existingMode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
  } catch {
    await unlink(tempPath).catch(() => undefined);
    const fallbackHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (getNodeErrorCode(error) === "ELOOP") {
        throw new SymlinkWriteRefusedError(
          `Refusing to write through symlink: ${path} (O_NOFOLLOW)`,
        );
      }
      throw error;
    });

    try {
      await fallbackHandle.writeFile(content);
      await fallbackHandle.sync();
    } finally {
      await fallbackHandle.close();
    }
  }
}
