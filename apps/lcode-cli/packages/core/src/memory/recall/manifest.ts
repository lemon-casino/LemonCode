import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileSystemPort, TraceContext } from "@lcode/contracts";

import {
  MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT,
  MEMORY_RECALL_DIRECTORY_LIMIT,
  MEMORY_RECALL_FILE_LIMIT,
  MEMORY_RECALL_INDEX_FILE_MAX_BYTES,
  MEMORY_RECALL_SCAN_CONCURRENCY,
} from "./constants.js";
import {
  awaitMemoryRecallOperation,
  mapWithFixedConcurrency,
  rethrowMemoryRecallAbort,
} from "./concurrency.js";
import { parseMemoryDocument } from "./document.js";
import type {
  MemoryCandidateScanResult,
  MemoryCandidateScanStats,
  MemoryManifestEntry,
} from "./types.js";

const MANIFEST_PREVIEW_LINE_LIMIT = 30;

interface MemoryScanInput {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

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
      input.signal,
    );
    return settled
      .filter(
        (result): result is PromiseFulfilledResult<MemoryManifestEntry> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch (error) {
    rethrowMemoryRecallAbort(error, input.signal);
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

export async function collectMemoryCandidatePaths(input: MemoryScanInput): Promise<string[]> {
  return (await scanMemoryCandidatePaths(input)).paths;
}

export async function scanMemoryCandidatePaths(
  input: MemoryScanInput,
): Promise<MemoryCandidateScanResult> {
  input.signal?.throwIfAborted();
  const paths: string[] = [];
  const directories = [input.rootDir];
  const seen = new Set([resolve(input.rootDir)]);
  const scan: MemoryCandidateScanStats = {
    complete: false,
    truncated: false,
    rejected: 0,
    failedDirectories: 0,
    scannedDirectories: 0,
    processedEntries: 0,
    unknownDirectories: 0,
  };

  while (
    scan.scannedDirectories < directories.length &&
    scan.scannedDirectories < MEMORY_RECALL_DIRECTORY_LIMIT &&
    scan.processedEntries < MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT &&
    paths.length < MEMORY_RECALL_FILE_LIMIT
  ) {
    const directory = directories[scan.scannedDirectories++]!;
    const remainingEntryBudget = MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT - scan.processedEntries;
    let listed;
    try {
      listed = await awaitMemoryRecallOperation(
        () =>
          input.fileSystem.listDirectory(
            {
              limit: remainingEntryBudget,
              path: directory,
              ...(input.traceContext ? { trace: input.traceContext } : {}),
            },
            { signal: input.signal },
          ),
        input.signal,
      );
    } catch (error) {
      rethrowMemoryRecallAbort(error, input.signal);
      scan.failedDirectories += 1;
      continue;
    }

    // 旧端口缺 truncated 字段并不等于目录完整；只记录已观察到的覆盖范围。
    if (listed.truncated !== true && listed.truncated !== false) scan.unknownDirectories += 1;
    if (
      listed.truncated === true ||
      listed.entries.length > remainingEntryBudget ||
      listed.numEntries > listed.entries.length
    )
      scan.truncated = true;
    const entries = listed.entries.slice(0, remainingEntryBudget).sort((left, right) => {
      if (left.name === right.name) return 0;
      return left.name < right.name ? -1 : 1;
    });
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      scan.processedEntries += 1;
      const key = resolve(entry.path);
      if (!isDirectChild(directory, entry.path) || seen.has(key)) {
        scan.rejected += 1;
        continue;
      }
      seen.add(key);
      if (entry.kind === "directory") {
        directories.push(entry.path);
        continue;
      }
      // Node stat/read 会跟随 symlink；recall 只接受 listDirectory 当时确认的普通文件，
      // 拒绝静态越界链接，也防止坏链接耗尽 200 个候选名额；原子防竞态需端口支持 no-follow。
      if (entry.kind !== "file" || !isMemoryCandidate(entry.path)) {
        scan.rejected += 1;
        continue;
      }
      paths.push(entry.path);
      if (paths.length >= MEMORY_RECALL_FILE_LIMIT) {
        // 明确 EOF 且恰好达到候选上限不是截断；只把未处理 entries/待扫目录记为缺口。
        if (index + 1 < entries.length) scan.truncated = true;
        break;
      }
    }
  }

  if (scan.scannedDirectories < directories.length) scan.truncated = true;
  scan.complete = !scan.truncated && scan.failedDirectories === 0 && scan.unknownDirectories === 0;
  return { paths, scan };
}

function isDirectChild(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== "" && child !== ".." && !isAbsolute(child) && !child.includes(sep);
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
