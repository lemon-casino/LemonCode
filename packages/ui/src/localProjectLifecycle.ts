import {
  isSameLocalProjectPath,
  localProjectPathKey,
  type AppSettings,
  type LocalProject,
  type LocalProjectRemoveRequest,
} from "@lcode/shared";

export interface LocalProjectWorkspaceReference {
  workspacePath: string;
  localProjectId?: string;
}

export function isWorkspaceReferenceForLocalProject(
  project: LocalProject,
  reference: LocalProjectWorkspaceReference,
): boolean {
  if (reference.localProjectId?.trim() === project.id) return true;
  return project.sourceFolderPaths.some((path) =>
    isSameLocalProjectPath(path, reference.workspacePath),
  );
}

export type LocalProjectRemovalPatch = Pick<
  AppSettings,
  "localProjects" | "recentProjects" | "lastWorkspaceSession" | "lastActiveTabIndex"
>;

type LocalProjectSettingsSnapshot = Pick<
  AppSettings,
  "localProjects" | "recentProjects" | "lastWorkspaceSession" | "lastActiveTabIndex"
>;

function buildRemovalPatch(
  settings: LocalProjectSettingsSnapshot,
  removedProjects: readonly LocalProject[],
): LocalProjectRemovalPatch | null {
  if (removedProjects.length === 0) return null;

  const removedIds = new Set(removedProjects.map((project) => project.id));
  const localProjects = settings.localProjects.filter((project) => !removedIds.has(project.id));
  const retainedFolderKeys = new Set(
    localProjects.flatMap((project) => project.sourceFolderPaths.map(localProjectPathKey)),
  );
  const removedFolderKeys = new Set(
    removedProjects
      .flatMap((project) => project.sourceFolderPaths.map(localProjectPathKey))
      .filter((key) => !retainedFolderKeys.has(key)),
  );
  const recentProjects = settings.recentProjects.filter(
    (path) => !removedFolderKeys.has(localProjectPathKey(path)),
  );
  const lastWorkspaceSession = (settings.lastWorkspaceSession ?? []).filter((entry) => {
    if (entry.kind === "remote") return true;
    if (entry.localProjectId && removedIds.has(entry.localProjectId)) return false;
    return !removedFolderKeys.has(localProjectPathKey(entry.workspacePath));
  });

  return {
    localProjects,
    recentProjects,
    lastWorkspaceSession,
    lastActiveTabIndex: Math.min(
      settings.lastActiveTabIndex ?? 0,
      Math.max(0, lastWorkspaceSession.length - 1),
    ),
  };
}

export function buildLocalProjectRemovalPatch(
  settings: LocalProjectSettingsSnapshot,
  request: LocalProjectRemoveRequest,
): LocalProjectRemovalPatch | null {
  const projectId = request.projectId?.trim();
  const removedProjects = settings.localProjects.filter(
    (project) =>
      (projectId ? project.id === projectId : false) ||
      project.sourceFolderPaths.some((path) => isSameLocalProjectPath(path, request.workspacePath)),
  );
  return buildRemovalPatch(settings, removedProjects);
}
