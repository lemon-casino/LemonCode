import { basename, relative, sep } from "node:path";
import type { FileSystemPort, TraceContext } from "@lcode/contracts";

import {
  MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT,
  MEMORY_RECALL_DIRECTORY_LIMIT,
  MEMORY_RECALL_FILE_LIMIT,
  MEMORY_RECALL_INDEX_FILE_MAX_BYTES,
  MEMORY_RECALL_SCAN_CONCURRENCY,
} from "./constants.js";
import { mapWithFixedConcurrency } from "./concurrency.js";
import { parseMemoryDocument } from "./document.js";
import type { MemoryManifestEntry } from "./types.js";

const MANIFEST_PREVIEW_LINE_LIMIT = 30;

export async function scanMemoryManifest(input: {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}): Promise<MemoryManifestEntry[]> {
  try {
    const paths = await collectMemoryCandidatePaths(input);
    const settled = await mapWithFixedConcurrency(
      paths,
      MEMORY_RECALL_SCAN_CONCURRENCY,
      async (filePath) =>
        await readManifestEntry(
          input.fileSystem,
          input.rootDir,
          filePath,
          input.signal,
          input.traceContext,
        ),
    );
    return settled
      .filter(
        (result): result is PromiseFulfilledResult<MemoryManifestEntry> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return [];
  }
}

export function formatMemoryManifest(manifest: readonly MemoryManifestEntry[]): string {
  return manifest
    .map((entry) => {
      const type = entry.type ? `[${entry.type}] ` : "";
      const timestamp = new Date(entry.mtimeMs).toISOString();
      const base = `- ${type}${entry.filename} (${timestamp})`;
      return entry.description ? `${base}: ${entry.description}` : base;
    })
    .join("\n");
}

export async function collectMemoryCandidatePaths(input: {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}): Promise<string[]> {
  const paths: string[] = [];
  const directories = [input.rootDir];
  let directoryCursor = 0;
  let processedEntryCount = 0;

  while (
    directoryCursor < directories.length &&
    directoryCursor < MEMORY_RECALL_DIRECTORY_LIMIT &&
    processedEntryCount < MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT &&
    paths.length < MEMORY_RECALL_FILE_LIMIT
  ) {
    const directory = directories[directoryCursor++];
    if (!directory) continue;

    let listed;
    try {
      listed = await input.fileSystem.listDirectory(
        {
          limit: MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT - processedEntryCount,
          path: directory,
          ...(input.traceContext ? { trace: input.traceContext } : {}),
        },
        { signal: input.signal },
      );
    } catch (error) {
      if (directory === input.rootDir) throw error;
      continue;
    }

    const remainingEntryBudget = MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT - processedEntryCount;
    const entries = listed.entries.slice(0, remainingEntryBudget).sort((left, right) => {
      if (left.name === right.name) return 0;
      return left.name < right.name ? -1 : 1;
    });
    for (const entry of entries) {
      processedEntryCount += 1;
      if (entry.kind === "directory") {
        directories.push(entry.path);
        continue;
      }
      // Node stat/read 会跟随 symlink；recall 只接受 listDirectory 当时确认的普通文件，
      // 拒绝静态越界链接，也防止坏链接耗尽 200 个候选名额；原子防竞态需端口支持 no-follow。
      if (entry.kind === "file" && isMemoryCandidate(entry.path)) {
        paths.push(entry.path);
        if (paths.length >= MEMORY_RECALL_FILE_LIMIT) break;
      }
    }
  }

  return paths;
}

function isMemoryCandidate(filePath: string): boolean {
  return filePath.endsWith(".md") && basename(filePath) !== "MEMORY.md";
}

async function readManifestEntry(
  fileSystem: FileSystemPort,
  rootDir: string,
  filePath: string,
  signal?: AbortSignal,
  traceContext?: TraceContext,
): Promise<MemoryManifestEntry> {
  const [stat, preview] = await Promise.all([
    fileSystem.stat(
      { path: filePath, ...(traceContext ? { trace: traceContext } : {}) },
      { signal },
    ),
    fileSystem.readTextFileRange(
      {
        path: filePath,
        offsetLine: 0,
        limitLines: MANIFEST_PREVIEW_LINE_LIMIT,
        maxBytes: MEMORY_RECALL_INDEX_FILE_MAX_BYTES,
        ...(traceContext ? { trace: traceContext } : {}),
      },
      { signal },
    ),
  ]);
  if (stat.kind !== "file") throw new Error("Memory manifest candidate is not a file");
  const frontmatter = parseMemoryDocument(preview.content);
  return {
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    filePath,
    filename: relative(rootDir, filePath).split(sep).join("/"),
    mtimeMs: stat.mtimeMs ?? 0,
    ...(frontmatter.type ? { type: frontmatter.type } : {}),
  };
}
