import {
  findLocalProjectForWorkspace,
  localProjectPathKey,
  type LocalProject,
  type RemoteTarget,
  type WorkspacePurpose,
} from "@lcode/shared";

export interface WorkspaceProjectMenuTab {
  workspacePath: string;
  label: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  localProjectId?: string;
}

function isRemoteWorkspaceTab(tab: WorkspaceProjectMenuTab): boolean {
  return Boolean(tab.workspaceIdentity || tab.remoteSessionId || tab.remoteTarget);
}

export function buildWorkspaceProjectMenuTabs({
  localProjects,
  workspaceTabs,
}: {
  localProjects: readonly LocalProject[];
  workspaceTabs: readonly WorkspaceProjectMenuTab[];
}): WorkspaceProjectMenuTab[] {
  const explicitFolderKeys = new Set(
    localProjects.flatMap((project) => project.sourceFolderPaths.map(localProjectPathKey)),
  );
  const explicitProjectTabs = localProjects.map((project) => {
    const openedTab = workspaceTabs.find((tab) => {
      if (isRemoteWorkspaceTab(tab) || tab.workspacePurpose === "conversation") {
        return false;
      }
      return (
        findLocalProjectForWorkspace(localProjects, tab.workspacePath, tab.localProjectId)?.id ===
        project.id
      );
    });
    return {
      ...(openedTab ?? {
        workspacePath: project.primaryFolderPath,
        label: project.name,
        workspacePurpose: "project" as const,
      }),
      workspacePath: project.primaryFolderPath,
      label: project.name,
      localProjectId: project.id,
    };
  });
  const remainingTabs = workspaceTabs.filter((tab) => {
    if (tab.workspacePurpose === "conversation") {
      return false;
    }
    if (isRemoteWorkspaceTab(tab)) {
      return true;
    }
    if (tab.localProjectId && localProjects.some((project) => project.id === tab.localProjectId)) {
      return false;
    }
    return !explicitFolderKeys.has(localProjectPathKey(tab.workspacePath));
  });
  return [...explicitProjectTabs, ...remainingTabs];
}
