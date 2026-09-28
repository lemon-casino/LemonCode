import { posix, win32 } from "node:path";

const WINDOWS_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

type PathApi = typeof posix;

export function formatToolFilePath(
  filePath: string | undefined,
  workspaceDirectory: string | undefined,
): string | undefined {
  const rawPath = filePath?.trim();
  if (!rawPath) return undefined;

  const pathApi = pathApiFor(rawPath, workspaceDirectory);
  if (!workspaceDirectory) return pathApi.normalize(rawPath);

  const workspaceRoot = pathApi.resolve(workspaceDirectory);
  const targetPath = pathApi.isAbsolute(rawPath)
    ? pathApi.normalize(rawPath)
    : pathApi.resolve(workspaceRoot, rawPath);
  const relativePath = pathApi.relative(workspaceRoot, targetPath);

  if (isWorkspaceRelativePath(relativePath, pathApi)) {
    return relativePath.length === 0 ? "." : relativePath;
  }

  return targetPath;
}

function pathApiFor(filePath: string, workspaceDirectory: string | undefined): PathApi {
  if (WINDOWS_PATH_PATTERN.test(filePath)) return win32;
  if (workspaceDirectory && WINDOWS_PATH_PATTERN.test(workspaceDirectory)) return win32;
  return posix;
}

function isWorkspaceRelativePath(relativePath: string, pathApi: PathApi): boolean {
  if (relativePath.length === 0) return true;
  if (pathApi.isAbsolute(relativePath)) return false;
  return relativePath !== ".." && !relativePath.startsWith(`..${pathApi.sep}`);
}
