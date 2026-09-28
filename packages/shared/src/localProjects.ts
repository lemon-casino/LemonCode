export const LOCAL_PROJECT_NAME_MAX_LENGTH = 100;
export const LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT = 20;

export interface LocalProject {
  id: string;
  name: string;
  primaryFolderPath: string;
  sourceFolderPaths: string[];
}

export interface CreateLocalProjectInput {
  id: string;
  name: string;
  sourceFolderPaths: readonly string[];
}

export interface LocalProjectCreateRequest {
  name: string;
  sourceFolderPaths: string[];
}

function stripTrailingPathSeparators(value: string): string {
  if (value === "/" || /^[A-Za-z]:[\\/]$/.test(value)) {
    return value;
  }
  return value.replace(/[\\/]+$/, "");
}

export function normalizeLocalProjectPath(value: string): string {
  return stripTrailingPathSeparators(value.trim());
}

export function localProjectPathKey(value: string): string {
  const normalized = normalizeLocalProjectPath(value).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isSameLocalProjectPath(left: string, right: string): boolean {
  return localProjectPathKey(left) === localProjectPathKey(right);
}

export function normalizeLocalProjectFolderPaths(paths: readonly string[]): string[] {
  const normalizedPaths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const normalizedPath = normalizeLocalProjectPath(rawPath);
    if (!normalizedPath) {
      continue;
    }
    const key = localProjectPathKey(normalizedPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedPaths.push(normalizedPath);
  }

  if (normalizedPaths.length === 0) {
    throw new Error("A local project requires at least one source folder.");
  }
  if (normalizedPaths.length > LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT) {
    throw new Error(
      `A local project supports at most ${LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT} source folders.`,
    );
  }
  return normalizedPaths;
}

export function normalizeLocalProjectName(name: string): string {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("A local project requires a name.");
  }
  if (normalizedName.length > LOCAL_PROJECT_NAME_MAX_LENGTH) {
    throw new Error(
      `A local project name supports at most ${LOCAL_PROJECT_NAME_MAX_LENGTH} characters.`,
    );
  }
  return normalizedName;
}

export function createLocalProject(input: CreateLocalProjectInput): LocalProject {
  const id = input.id.trim();
  if (!id) {
    throw new Error("A local project requires an id.");
  }
  const sourceFolderPaths = normalizeLocalProjectFolderPaths(input.sourceFolderPaths);
  return {
    id,
    name: normalizeLocalProjectName(input.name),
    primaryFolderPath: sourceFolderPaths[0]!,
    sourceFolderPaths,
  };
}

export function findLocalProjectForWorkspace(
  projects: readonly LocalProject[],
  workspacePath: string,
  localProjectId?: string,
): LocalProject | undefined {
  const normalizedProjectId = localProjectId?.trim();
  if (normalizedProjectId) {
    const byId = projects.find((project) => project.id === normalizedProjectId);
    if (byId) {
      return byId;
    }
  }
  return projects.find((project) =>
    isSameLocalProjectPath(project.primaryFolderPath, workspacePath),
  );
}

export function hasLocalProjectPrimaryFolderConflict(
  projects: readonly LocalProject[],
  primaryFolderPath: string,
): boolean {
  return projects.some((project) =>
    isSameLocalProjectPath(project.primaryFolderPath, primaryFolderPath),
  );
}
