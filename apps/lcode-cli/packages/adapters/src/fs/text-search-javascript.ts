import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  createFileSystemError,
  type FileSystemSearchTextEntry,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
} from "@lcode/contracts";
import {
  resolveAbsoluteRequestPath,
  throwIfAborted,
  toFileSystemError,
} from "./file-system-common.js";
import { createGlobMatcher, matchesFileType, toPosixRelative, walkFiles } from "./file-search.js";
import { searchLineContent, searchMultilineContent } from "./text-search-content.js";
import { finishTextSearchResult } from "./text-search-output.js";

interface FileSearchCandidate {
  path: string;
  mtimeMs: number;
}

export async function searchTextWithJavaScript(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  try {
    throwIfAborted(signal);
    const regex = compileSearchRegex(pattern, request);
    const rootInfo = await stat(path);
    const mode = request.outputMode ?? "files_with_matches";
    const candidates = await collectTextSearchCandidates(path, rootInfo, request, signal);

    const searchRequest = mode === "content" ? request : { ...request, onlyMatching: false };
    const contentEntries: FileSystemSearchTextEntry[] = [];
    const countEntries: FileSystemSearchTextEntry[] = [];
    const matchingFiles: Array<{ path: string; mtimeMs: number }> = [];
    let numMatches = 0;

    for (const candidate of candidates) {
      throwIfAborted(signal);
      const content = await readFile(candidate.path, "utf8");
      if (looksBinary(content)) continue;

      const search = request.multiline
        ? searchMultilineContent(candidate.path, content, regex, searchRequest)
        : searchLineContent(candidate.path, content, regex, searchRequest);

      if (search.matchCount === 0) continue;

      numMatches += search.matchCount;
      matchingFiles.push({ path: candidate.path, mtimeMs: candidate.mtimeMs });
      if (mode === "content") {
        contentEntries.push(...search.entries);
      } else if (mode === "count") {
        countEntries.push({
          path: candidate.path,
          count: search.matchCount,
        });
      }
    }

    matchingFiles.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    return finishTextSearchResult({
      path,
      pattern,
      mode,
      startedAt,
      request,
      files: matchingFiles.map((item) => item.path),
      entries: mode === "content" ? contentEntries : countEntries,
      numMatches,
    });
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

function compileSearchRegex(pattern: string, request: FileSystemSearchTextRequest): RegExp {
  try {
    const flags = `${request.ignoreCase ? "i" : ""}${request.multiline ? "s" : ""}`;
    return new RegExp(pattern, flags);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path: request.path,
      message: `Invalid grep regular expression: ${pattern}`,
      cause: error,
    });
  }
}

async function collectTextSearchCandidates(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const candidates: FileSearchCandidate[] = [];
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;
  const root = rootInfo.isDirectory() ? path : dirname(path);

  const addIfCandidate = async (filePath: string, info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) return;
    const relativePath = toPosixRelative(root, filePath);
    if (globMatcher && !globMatcher(relativePath, basename(filePath))) return;
    if (request.type && !matchesFileType(filePath, request.type)) return;
    candidates.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
  };

  if (rootInfo.isFile()) {
    await addIfCandidate(path, rootInfo);
    return candidates;
  }

  if (!rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  await walkFiles(root, signal, addIfCandidate);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return candidates;
}

function looksBinary(content: string): boolean {
  return content.includes("\0");
}
