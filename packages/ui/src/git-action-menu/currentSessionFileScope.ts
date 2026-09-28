import type { GitFileChange, GitRepositorySummary, LCodeTaskChangeSummary } from "@lcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

function normalizeCommitScopePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function normalizeBasePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeWorkspaceInRepoPath(path: string): string {
  const normalized = normalizeCommitScopePath(path);
  return normalized.length > 0 ? normalized : ".";
}

function stripBasePath(path: string, basePath: string): string | null {
  const normalizedPath = normalizeBasePath(path);
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedPath || !normalizedBasePath) {
    return null;
  }

  if (normalizedPath === normalizedBasePath) {
    return "";
  }

  const prefix = `${normalizedBasePath}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  const lowerPath = normalizedPath.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerPath.startsWith(lowerPrefix)) {
    return normalizedPath.slice(prefix.length);
  }

  return null;
}

function addScopePath(scope: Set<string>, path: string | null): void {
  if (path === null) {
    return;
  }

  const normalizedPath = normalizeCommitScopePath(path);
  if (normalizedPath) {
    scope.add(normalizedPath);
  }
}

function buildCurrentSessionFileScope(options: {
  currentSessionFilePaths?: readonly string[];
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): Set<string> | null {
  const filePaths = options.currentSessionFilePaths
    ?.map((path) => path.trim())
    .filter((path) => path.length > 0);
  if (!filePaths) {
    return null;
  }

  const scope = new Set<string>();
  const workspaceInRepoPath = normalizeWorkspaceInRepoPath(options.gitSummary.workspaceInRepoPath);

  for (const filePath of filePaths) {
    addScopePath(scope, filePath);
    addScopePath(scope, stripBasePath(filePath, options.gitSummary.repoRoot));
    addScopePath(scope, stripBasePath(filePath, options.workspacePath));

    const normalizedPath = normalizeCommitScopePath(filePath);
    if (workspaceInRepoPath !== "." && !normalizedPath.startsWith(`${workspaceInRepoPath}/`)) {
      addScopePath(scope, `${workspaceInRepoPath}/${normalizedPath}`);
    }
  }

  return scope.size > 0 ? scope : null;
}

function isPreviewFileInScope(
  file: GitBranchCommitPreviewFile,
  scope: Set<string> | null,
): boolean {
  if (!scope) {
    return true;
  }

  return [file.stagePath, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
    scope.has(normalizeCommitScopePath(path)),
  );
}

function isGitFileInScope(file: GitFileChange, scope: Set<string> | null): boolean {
  if (!scope) {
    return true;
  }

  return [file.path, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
    scope.has(normalizeCommitScopePath(path)),
  );
}

export function getCurrentSessionFilePaths(
  summary: LCodeTaskChangeSummary | null,
): string[] | undefined {
  const paths = Array.from(
    new Set(
      (summary?.files ?? []).map((file) => file.path.trim()).filter((path) => path.length > 0),
    ),
  );
  return paths.length > 0 ? paths : undefined;
}

export function filterCommitPreviewFilesByCurrentSession(options: {
  files: readonly GitBranchCommitPreviewFile[];
  summary: LCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): GitBranchCommitPreviewFile[] {
  return filterCommitPreviewFilesByPaths({
    files: options.files,
    currentSessionFilePaths: getCurrentSessionFilePaths(options.summary),
    gitSummary: options.gitSummary,
    workspacePath: options.workspacePath,
  });
}

export function filterCommitPreviewFilesByPaths(options: {
  files: readonly GitBranchCommitPreviewFile[];
  currentSessionFilePaths?: readonly string[];
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): GitBranchCommitPreviewFile[] {
  const scope = buildCurrentSessionFileScope({
    currentSessionFilePaths: options.currentSessionFilePaths,
    gitSummary: options.gitSummary,
    workspacePath: options.workspacePath,
  });
  return options.files.filter((file) => isPreviewFileInScope(file, scope));
}

export function filterGitFilesByCurrentSession(options: {
  files: readonly GitFileChange[];
  currentSessionFilePaths?: readonly string[];
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): GitFileChange[] {
  const scope = buildCurrentSessionFileScope({
    currentSessionFilePaths: options.currentSessionFilePaths,
    gitSummary: options.gitSummary,
    workspacePath: options.workspacePath,
  });
  return options.files.filter((file) => isGitFileInScope(file, scope));
}

export function buildGitChangesFingerprint(options: {
  files: readonly GitFileChange[];
  currentSessionFilePaths: readonly string[];
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): string | null {
  if (!options.currentSessionFilePaths.some((path) => path.trim().length > 0)) {
    return null;
  }
  const files = filterGitFilesByCurrentSession(options);
  if (files.length === 0) {
    return null;
  }

  const entries = files
    .map((file) => [
      normalizeCommitScopePath(file.repoRelativePath || file.path),
      file.section,
      file.kind,
      file.added,
      file.removed,
      file.isStaged,
      file.isUntracked,
      file.isConflicted,
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(entries);
}
