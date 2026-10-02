// Node FileSystem Adapter — port facade; operations share the existing adapter options.
import { mkdir, stat } from "node:fs/promises";
import {
  createFileSystemError,
  type FileSystemPort,
  type FileSystemOperationOptions,
  type FileSystemCreateDirectoryRequest,
  type FileSystemCreateDirectoryResult,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemListDirectoryRequest,
  type FileSystemListDirectoryResult,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@lcode/contracts";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";
import { listNodeDirectoryEntries } from "./directory-listing.js";
import {
  nodeKind,
  resolveAbsoluteRequestPath,
  revisionId,
  throwIfAborted,
  toFileSystemError,
} from "./file-system-common.js";
import { readBinaryFile, readTextFile, readTextFileRange } from "./file-read.js";
import { removeFile, writeTextFile } from "./file-write.js";
import { NodeProjectMemory } from "./project-memory.js";
import { searchFiles } from "./file-search.js";
import { searchTextWithJavaScript } from "./text-search-javascript.js";
import { searchTextWithRipgrep } from "./ripgrep-search.js";
import { RipgrepRuntimeFailure } from "./ripgrep-worker.js";

export { setRipgrepTimeoutMsForTests, setRipgrepWorkerFactoryForTests } from "./ripgrep-worker.js";

export interface NodeFileSystemAdapterOptions {
  textSearchEngine?: "ripgrep" | "javascript";
}

export class NodeFileSystemAdapter implements FileSystemPort {
  readonly projectMemory = new NodeProjectMemory();

  constructor(private readonly adapterOptions: NodeFileSystemAdapterOptions = {}) {}

  async createDirectory(
    request: FileSystemCreateDirectoryRequest,
  ): Promise<FileSystemCreateDirectoryResult> {
    await this.projectMemory.guardOrdinaryMutation(request.path, "mkdir");
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      maybeThrowStorageFsFault({ operation: "mkdir", path });
      await mkdir(path, { recursive: true });
      return { path };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      const info = await stat(path);
      const kind = nodeKind(info);
      return {
        path,
        kind,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        revision:
          kind === "file"
            ? {
                id: revisionId(info.mtimeMs, info.size),
                mtimeMs: info.mtimeMs,
                sizeBytes: info.size,
              }
            : undefined,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
    return readTextFile(request);
  }

  async readBinaryFile(request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
    return readBinaryFile(request);
  }

  async readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemReadTextRangeResult> {
    return readTextFileRange(request, options);
  }

  async writeTextFile(
    request: FileSystemWriteTextRequest,
    options: FileSystemOperationOptions = {},
  ): Promise<FileSystemWriteTextResult> {
    return (await this.projectMemory.write(request, options)) ?? writeTextFile(request, options);
  }

  async removeFile(
    request: FileSystemRemoveFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemRemoveFileResult> {
    await this.projectMemory.guardOrdinaryMutation(request.path, "remove");
    return removeFile(request, options);
  }

  async searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchFilesResult> {
    return searchFiles(request, options);
  }

  async listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemListDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const startedAt = Date.now();

    try {
      throwIfAborted(options?.signal);
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Directory listing path must be a directory: ${path}`,
        });
      }

      const listed = await listNodeDirectoryEntries({
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        path,
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      return {
        path,
        durationMs: Math.max(0, Date.now() - startedAt),
        entries: listed.entries,
        numEntries: listed.entries.length,
        truncated: listed.truncated,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async searchText(
    request: FileSystemSearchTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const normalizedRequest = request.path === path ? request : { ...request, path };

    if (this.adapterOptions.textSearchEngine === "javascript") {
      return searchTextWithJavaScript(normalizedRequest, options?.signal);
    }

    try {
      return await searchTextWithRipgrep(normalizedRequest, options?.signal);
    } catch (error) {
      if (error instanceof RipgrepRuntimeFailure) {
        return searchTextWithJavaScript(normalizedRequest, options?.signal);
      }
      throw toFileSystemError(error, path);
    }
  }
}

export function createNodeFileSystemAdapter(
  options: NodeFileSystemAdapterOptions = {},
): NodeFileSystemAdapter {
  return new NodeFileSystemAdapter(options);
}
