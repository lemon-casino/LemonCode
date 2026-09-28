import { createNodeFileSystemAdapter } from "@lcode/adapters/fs";
import type { FileSystemPort } from "@lcode/contracts";
import type { TuiListWorkspacePathSuggestions, TuiWorkspacePathSuggestion } from "@lcode/tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_WORKSPACE_PATH_SUGGESTION_LIMIT = 50;
const PATH_SEPARATOR_PATTERN = /[\\/]+/gu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/u;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".bzr",
  ".git",
  ".hg",
  ".jj",
  ".sl",
  ".svn",
  "node_modules",
]);

export function createWorkspacePathSuggestionProvider(options: {
  fileSystemPort?: FileSystemPort;
  workspaceDirectory: string;
}): TuiListWorkspacePathSuggestions {
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  const workspaceDirectory = resolve(options.workspaceDirectory);

  return async (request) => {
    const parsed = parseWorkspacePathToken(request.token);
    if (!parsed) return { items: [], truncated: false };

    const directory = resolve(workspaceDirectory, parsed.directoryToken);
    if (!isPathInside(workspaceDirectory, directory)) {
      return { items: [], truncated: false };
    }

    try {
      const listed = await fileSystemPort.listDirectory(
        { path: directory },
        { signal: request.abortSignal },
      );
      const candidates = listed.entries
        .flatMap((entry): TuiWorkspacePathSuggestion[] => {
          if (entry.kind !== "directory" && entry.kind !== "file") return [];
          if (entry.kind === "directory" && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) return [];
          if (!parsed.query.startsWith(".") && entry.name.startsWith(".")) return [];
          if (!matchesPathQuery(entry.name, parsed.query)) return [];

          const relativePath = toWorkspaceRelativePath(workspaceDirectory, entry.path);
          if (!relativePath) return [];
          return [
            {
              kind: entry.kind,
              path: entry.kind === "directory" ? `${relativePath}/` : relativePath,
            },
          ];
        })
        .sort((left, right) => compareWorkspacePathSuggestion(left, right, parsed.query));

      const limit = Math.max(
        1,
        Math.floor(request.limit ?? DEFAULT_WORKSPACE_PATH_SUGGESTION_LIMIT),
      );
      return {
        items: candidates.slice(0, limit),
        truncated: candidates.length > limit,
      };
    } catch {
      return { items: [], truncated: false };
    }
  };
}

function parseWorkspacePathToken(
  token: string,
): { directoryToken: string; query: string } | undefined {
  const trimmed = token.replace(/^@/u, "");
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    isAbsolute(trimmed) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
  ) {
    return undefined;
  }

  const normalized = trimmed.replace(PATH_SEPARATOR_PATTERN, "/");
  if (normalized.split("/").some((part) => part === "..")) return undefined;
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return { directoryToken: "", query: normalized };
  }
  return {
    directoryToken: normalized.slice(0, slashIndex + 1),
    query: normalized.slice(slashIndex + 1),
  };
}

function matchesPathQuery(name: string, query: string): boolean {
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

function compareWorkspacePathSuggestion(
  left: TuiWorkspacePathSuggestion,
  right: TuiWorkspacePathSuggestion,
  query: string,
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  const leftName = basenameFromSuggestion(left.path);
  const rightName = basenameFromSuggestion(right.path);
  const queryLower = query.toLowerCase();
  const leftPrefix = leftName.toLowerCase().startsWith(queryLower);
  const rightPrefix = rightName.toLowerCase().startsWith(queryLower);
  if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
  return left.path.localeCompare(right.path);
}

function basenameFromSuggestion(path: string): string {
  const withoutSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const slashIndex = withoutSlash.lastIndexOf("/");
  return slashIndex < 0 ? withoutSlash : withoutSlash.slice(slashIndex + 1);
}

function toWorkspaceRelativePath(workspaceDirectory: string, path: string): string | undefined {
  const relativePath = relative(workspaceDirectory, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
