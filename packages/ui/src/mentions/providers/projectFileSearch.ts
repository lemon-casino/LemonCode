import {
  isSameLocalProjectPath,
  localProjectPathKey,
  type WorkspaceFileEntry,
} from "@lcode/shared";

export interface ProjectFileEntry {
  entry: WorkspaceFileEntry;
  rootPath: string;
  primary: boolean;
}

export function mergeProjectFileEntries(
  resultGroups: ReadonlyArray<{
    rootPath: string;
    entries: readonly WorkspaceFileEntry[];
  }>,
  primaryFolderPath: string,
  limit: number,
): ProjectFileEntry[] {
  const maxGroupLength = Math.max(0, ...resultGroups.map((group) => group.entries.length));
  const merged: ProjectFileEntry[] = [];
  const seenEntryPaths = new Set<string>();
  for (let index = 0; index < maxGroupLength && merged.length < limit; index += 1) {
    for (const group of resultGroups) {
      const entry = group.entries[index];
      if (!entry) continue;
      const entryPathKey = localProjectPathKey(entry.path);
      if (seenEntryPaths.has(entryPathKey)) continue;
      seenEntryPaths.add(entryPathKey);
      merged.push({
        entry,
        rootPath: group.rootPath,
        primary: isSameLocalProjectPath(group.rootPath, primaryFolderPath),
      });
      if (merged.length >= limit) break;
    }
  }
  return merged;
}
