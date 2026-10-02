import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import {
  createFileSystemError,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
} from "@lcode/contracts";
import {
  resolveAbsoluteRequestPath,
  throwIfAborted,
  toFileSystemError,
} from "./file-system-common.js";

const DEFAULT_GLOB_MAX_RESULTS = 100;

export const VCS_DIRECTORIES_TO_EXCLUDE = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

export async function searchFiles(
  request: FileSystemSearchFilesRequest,
  options?: { signal?: AbortSignal },
): Promise<FileSystemSearchFilesResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Glob pattern must not be empty",
    });
  }

  try {
    throwIfAborted(options?.signal);
    const rootInfo = await stat(path);
    if (!rootInfo.isDirectory()) {
      throw createFileSystemError({
        code: "not_file",
        path,
        message: `Glob search path must be a directory: ${path}`,
      });
    }

    const matcher = createGlobMatcher(pattern);
    const matches: Array<{ path: string; mtimeMs: number }> = [];

    await walkFiles(path, options?.signal, async (filePath, info) => {
      const relativePath = toPosixRelative(path, filePath);
      if (matcher(relativePath, basename(filePath))) {
        matches.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
      }
    });

    matches.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    const offset = request.offset ?? 0;
    const maxResults = request.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
    const files = matches.slice(offset, offset + maxResults).map((match) => match.path);

    return {
      path,
      pattern,
      durationMs: Math.max(0, Date.now() - startedAt),
      files,
      numFiles: files.length,
      truncated: matches.length > offset + maxResults,
    };
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

export async function walkFiles(
  current: string,
  signal: AbortSignal | undefined,
  visitor: (path: string, info: Awaited<ReturnType<typeof stat>>) => Promise<void> | void,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    throwIfAborted(signal);
    const childPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (VCS_DIRECTORIES_TO_EXCLUDE.has(entry.name)) continue;
      await walkFiles(childPath, signal, visitor);
      continue;
    }

    if (!entry.isFile()) continue;

    const info = await stat(childPath);
    await visitor(childPath, info);
  }
}

export function createGlobMatcher(
  pattern: string,
): (relativePath: string, fileName: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  const regex = globPatternToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : globPatternToRegExp(normalized);

  return (relativePath, fileName) =>
    regex.test(relativePath) || (basenameRegex ? basenameRegex.test(fileName) : false);
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        regex += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }

    regex += escapeRegExp(char ?? "");
  }

  regex += "$";
  try {
    return new RegExp(regex);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      message: `Invalid glob pattern: ${pattern}`,
      cause: error,
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function toPosixRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

export function fileTypeGlobPatterns(type: string): string[] {
  const normalized = normalizeFileType(type);
  if (!/^[a-z0-9_+-]+$/i.test(normalized)) return [];
  const extensions = TYPE_EXTENSION_MAP[normalized] ?? [`.${normalized}`];
  return extensions.flatMap((extension) => [`*${extension}`, `**/*${extension}`]);
}

function normalizeFileType(type: string): string {
  return type.toLowerCase().replace(/^\./, "");
}

export function matchesFileType(path: string, type: string): boolean {
  const normalized = type.toLowerCase().replace(/^\./, "");
  const extension = extname(path).toLowerCase();
  const known = TYPE_EXTENSION_MAP[normalized];
  if (known) {
    return known.includes(extension);
  }
  return extension === `.${normalized}`;
}

const TYPE_EXTENSION_MAP: Record<string, string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  css: [".css"],
  go: [".go"],
  html: [".html", ".htm"],
  java: [".java"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc"],
  markdown: [".md", ".markdown"],
  md: [".md", ".markdown"],
  py: [".py"],
  python: [".py"],
  rs: [".rs"],
  rust: [".rs"],
  sh: [".sh", ".bash", ".zsh"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  tsx: [".tsx"],
  txt: [".txt"],
  yaml: [".yaml", ".yml"],
};
