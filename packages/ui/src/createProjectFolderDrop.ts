import {
  LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
  localProjectPathKey,
  normalizeLocalProjectPath,
} from "@lcode/shared";

export interface MergeLocalProjectFolderPathsResult {
  paths: string[];
  addedPaths: string[];
  discardedForLimitCount: number;
}

/** Merge picker/drop results while preserving primary-folder order. */
export function mergeLocalProjectFolderPaths(
  currentPaths: readonly string[],
  candidatePaths: readonly string[],
  maxCount = LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
): MergeLocalProjectFolderPathsResult {
  const paths = currentPaths.map(normalizeLocalProjectPath).filter(Boolean);
  const seen = new Set(paths.map(localProjectPathKey));
  const addedPaths: string[] = [];
  let discardedForLimitCount = 0;

  for (const candidatePath of candidatePaths) {
    const path = normalizeLocalProjectPath(candidatePath);
    if (!path) continue;

    const key = localProjectPathKey(path);
    if (seen.has(key)) continue;

    if (paths.length >= maxCount) {
      discardedForLimitCount += 1;
      continue;
    }

    seen.add(key);
    paths.push(path);
    addedPaths.push(path);
  }

  return { paths, addedPaths, discardedForLimitCount };
}

export interface ResolveDroppedLocalProjectFoldersResult {
  folderPaths: string[];
  rejectedCount: number;
}

/** Resolve Electron drag payloads and keep only paths verified as directories. */
export async function resolveDroppedLocalProjectFolders<T>(
  files: readonly T[],
  getPathForFile: (file: T) => string | null,
  statPath: (path: string) => Promise<"file" | "directory">,
): Promise<ResolveDroppedLocalProjectFoldersResult> {
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const path = normalizeLocalProjectPath(getPathForFile(file) ?? "");
        if (!path) return null;
        return (await statPath(path)) === "directory" ? path : null;
      } catch {
        return null;
      }
    }),
  );
  const folderPaths = results.filter((path): path is string => path !== null);
  return { folderPaths, rejectedCount: files.length - folderPaths.length };
}
