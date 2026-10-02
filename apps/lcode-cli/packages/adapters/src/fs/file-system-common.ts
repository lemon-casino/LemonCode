import { createHash } from "node:crypto";
import type { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { createFileSystemError, type FileSystemNodeKind } from "@lcode/contracts";

export function getNodeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

export function nodeKind(info: Awaited<ReturnType<typeof stat>>): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

export function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

export function resolveAbsoluteRequestPath(path: string): string {
  if (!isAbsolute(path)) {
    throw createFileSystemError({
      code: "invalid_path",
      path,
      message: `FileSystemPort requires an absolute path: ${path}`,
    });
  }
  return normalize(path);
}

export function hashBuffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatByteUnit(bytes / 1024)}KB`;
  return `${formatByteUnit(bytes / (1024 * 1024))}MB`;
}

function formatByteUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

export function toFileSystemError(error: unknown, path: string): Error {
  if (error instanceof Error && error.name === "FileSystemPortError") {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    // Preserve cancellation as its own code so tools do not report user aborts as I/O failures.
    return createFileSystemError({
      code: "cancelled",
      path,
      message: `File system operation was cancelled: ${path}`,
      cause: error,
    });
  }

  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return createFileSystemError({
      code: "not_found",
      path,
      message: `File not found: ${path}`,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message: `Permission denied for path: ${path}`,
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return createFileSystemError({
      code: "is_directory",
      path,
      message: `Path is a directory: ${path}`,
      cause: error,
    });
  }
  if (code === "ENAMETOOLONG") {
    return createFileSystemError({
      code: "invalid_path",
      path,
      message: `Invalid path: ${path}`,
      cause: error,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : `File system error for path: ${path}`,
    cause: error,
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled");
  error.name = "AbortError";
  throw error;
}
