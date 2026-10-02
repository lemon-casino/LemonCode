import { createHash } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  FileSystemListDirectoryEntry,
  FileSystemListDirectoryResult,
  FileSystemPort,
} from "@lcode/contracts";

export interface RecallTestFile {
  content: string;
  mtimeMs?: number;
  readable?: boolean;
  statError?: Error;
  sizeBytes?: number;
  omitHash?: boolean;
}

export function createRecallHarness(files: Map<string, RecallTestFile>) {
  const lists: string[] = [];
  const reads: Array<{ path: string; maxBytes?: number }> = [];
  const stats: string[] = [];
  const readMaxBytes: Array<number | undefined> = [];
  const listings = new Map<string, Partial<FileSystemListDirectoryResult> | Error>();
  const fileSystem = {
    async listDirectory(request: { path: string; limit?: number }) {
      lists.push(request.path);
      const override = listings.get(request.path);
      if (override instanceof Error) throw override;
      const entries = new Map<string, FileSystemListDirectoryEntry>();
      for (const path of files.keys()) {
        const suffix = relative(request.path, path);
        if (!suffix || suffix.startsWith("..") || suffix === path) continue;
        const name = suffix.split(sep)[0]!;
        entries.set(name, {
          kind: dirname(path) === request.path ? "file" : "directory",
          name,
          path: dirname(path) === request.path ? path : join(request.path, name),
        });
      }
      const sorted = [...entries.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      return {
        durationMs: 0,
        entries: sorted.slice(0, request.limit),
        numEntries: Math.min(sorted.length, request.limit ?? sorted.length),
        path: request.path,
        truncated: request.limit !== undefined && sorted.length > request.limit,
        ...override,
      };
    },
    async stat(request: { path: string }) {
      stats.push(request.path);
      const file = files.get(request.path);
      if (!file) throw new Error("file not found");
      if (file.statError) throw file.statError;
      return {
        kind: "file" as const,
        ...(file.mtimeMs === undefined ? {} : { mtimeMs: file.mtimeMs }),
        path: request.path,
        sizeBytes: file.sizeBytes ?? Buffer.byteLength(file.content),
      };
    },
    async readTextFile(request: { path: string; maxBytes?: number }) {
      reads.push(request);
      readMaxBytes.push(request.maxBytes);
      const file = files.get(request.path);
      if (!file || file.readable === false) throw new Error("file unreadable");
      const raw = Buffer.from(file.content);
      const bytes = raw.subarray(0, request.maxBytes);
      return {
        bytesRead: bytes.length,
        content: bytes.toString().replace(/\r\n/gu, "\n"),
        encoding: "utf8" as const,
        lineEndings: file.content.includes("\r\n") ? ("CRLF" as const) : ("LF" as const),
        path: request.path,
        sizeBytes: file.sizeBytes ?? raw.length,
        truncated: bytes.length < raw.length,
        ...(file.omitHash
          ? {}
          : {
              revision: {
                id: "test-revision",
                hash: hashContent(bytes),
                ...(file.mtimeMs === undefined ? {} : { mtimeMs: file.mtimeMs }),
              },
            }),
      };
    },
  } as unknown as FileSystemPort;
  return {
    fileSystem,
    files,
    lists,
    reads,
    stats,
    listings,
    readCount: () => reads.length,
    statCount: () => stats.length,
    readMaxBytes: () => [...readMaxBytes],
  };
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function memoryEntry(path: string, kind: FileSystemListDirectoryEntry["kind"] = "file") {
  return { kind, name: basename(path), path };
}
