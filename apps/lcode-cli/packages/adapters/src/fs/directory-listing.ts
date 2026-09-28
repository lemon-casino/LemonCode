import type { Dirent } from "node:fs";
import { opendir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createFileSystemError,
  type FileSystemListDirectoryEntry,
  type FileSystemNodeKind,
} from "@lcode/contracts";

const DIRECTORY_BUFFER_SIZE = 32;

interface DirectoryReader {
  close(): Promise<void>;
  read(): Promise<Dirent | null>;
}

export async function listNodeDirectoryEntries(input: {
  limit?: number;
  path: string;
  signal?: AbortSignal;
}): Promise<{ entries: FileSystemListDirectoryEntry[]; truncated: boolean }> {
  const limit = validateDirectoryListingLimit(input.path, input.limit);
  throwIfDirectoryListingAborted(input.signal);

  if (limit === undefined) {
    const dirents = await readdir(input.path, { withFileTypes: true });
    throwIfDirectoryListingAborted(input.signal);
    return { entries: mapAndSortEntries(input.path, dirents), truncated: false };
  }

  const directory = await opendir(input.path, {
    bufferSize: Math.min(DIRECTORY_BUFFER_SIZE, limit),
  });
  return await readBoundedDirectoryEntries({
    directory,
    limit,
    path: input.path,
    signal: input.signal,
  });
}

export async function readBoundedDirectoryEntries(input: {
  directory: DirectoryReader;
  limit: number;
  path: string;
  signal?: AbortSignal;
}): Promise<{ entries: FileSystemListDirectoryEntry[]; truncated: boolean }> {
  const dirents: Dirent[] = [];
  try {
    while (dirents.length < input.limit) {
      throwIfDirectoryListingAborted(input.signal);
      const entry = await input.directory.read();
      throwIfDirectoryListingAborted(input.signal);
      if (!entry) {
        return { entries: mapAndSortEntries(input.path, dirents), truncated: false };
      }
      dirents.push(entry);
    }

    // 为了守住真实读取上限，这里不额外读取第 limit+1 项；命中上限时保守标记可能被截断。
    return { entries: mapAndSortEntries(input.path, dirents), truncated: true };
  } finally {
    await input.directory.close();
  }
}

function validateDirectoryListingLimit(
  path: string,
  limit: number | undefined,
): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw createFileSystemError({
      code: "invalid_limit",
      path,
      message: `Directory listing limit must be a positive safe integer: ${String(limit)}`,
    });
  }
  return limit;
}

function mapAndSortEntries(
  path: string,
  dirents: readonly Dirent[],
): FileSystemListDirectoryEntry[] {
  return dirents
    .map((entry) => ({
      kind: direntKind(entry),
      name: entry.name,
      path: join(path, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function direntKind(info: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function throwIfDirectoryListingAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Directory listing was cancelled");
  error.name = "AbortError";
  throw error;
}
