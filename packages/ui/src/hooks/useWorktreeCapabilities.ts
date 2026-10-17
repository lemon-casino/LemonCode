import { useEffect, useMemo, useState } from "react";
import type { WorktreeCapabilities } from "@lcode/services";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  findProjectDefinition,
  projectContextForDefinition,
  replaceRemoteWorkspaceIdentityPath,
} from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
export interface CollaborationRepositorySource {
  workspacePath: string;
  workspaceIdentity?: string;
  memberIds: string[];
  currentBranch: string | null;
}

export function useWorktreeCapabilities(
  workspacePath: string,
  workspaceIdentity?: string,
  revision?: string,
) {
  const { worktreeService, projectExecutionSetService } = useServices();
  const { settings } = useSettings(useBaseWorkspaceServices());
  const project = findProjectDefinition(
    settings?.projectDefinitions?.projects ?? settings?.localProjects ?? [],
    workspacePath,
    workspaceIdentity,
  );
  const members = useMemo(
    () =>
      project
        ? projectContextForDefinition(project, { workspacePath, workspaceIdentity }).members
        : [],
    [project, workspacePath, workspaceIdentity],
  );
  const sourceFolderPaths = useMemo(
    () => (project ? members.map((member) => member.sourcePath) : undefined),
    [project, members],
  );
  const collaboration = (sourceFolderPaths?.length ?? 0) > 1;
  const scope = workspaceIdentity?.trim() || workspacePath;
  const observationKey = JSON.stringify([scope, project?.id, project?.revision, sourceFolderPaths]);
  const [state, setState] = useState<{
    scope: string;
    key: string;
    capabilities?: WorktreeCapabilities;
    repositories?: CollaborationRepositorySource[];
    error?: string;
    loading: boolean;
  }>({ scope, key: observationKey, loading: true });
  useEffect(() => {
    let current = true;
    if (!worktreeService) {
      setState({ scope, key: observationKey, loading: false });
      return;
    }
    setState({ scope, key: observationKey, loading: true });
    let repositories: CollaborationRepositorySource[] | undefined;
    const read = async () => {
      if (!collaboration)
        return worktreeService.getCapabilities({
          workspacePath,
          workspaceIdentity,
          sourceFolderPaths,
        });
      if (
        !projectExecutionSetService ||
        (await projectExecutionSetService.capabilities()).protocolVersion !== 1
      )
        throw new Error("This Host does not support collaboration execution sets");
      const capabilities: WorktreeCapabilities[] = [];
      for (let offset = 0; offset < sourceFolderPaths!.length; offset += 4)
        capabilities.push(
          ...(await Promise.all(
            sourceFolderPaths!.slice(offset, offset + 4).map(async (path) => {
              const value = await worktreeService.getCapabilities({
                workspacePath: path,
                workspaceIdentity: workspaceIdentity
                  ? (replaceRemoteWorkspaceIdentityPath(workspaceIdentity, path) ?? undefined)
                  : undefined,
              });
              return {
                ...value,
                reason: value.create
                  ? undefined
                  : `${path}: ${value.reason ?? "Repository unavailable"}`,
              };
            }),
          )),
        );
      const grouped = new Map<string, CollaborationRepositorySource>();
      for (const [index, value] of capabilities.entries()) {
        if (!value.repositoryRoot) continue;
        let repository = grouped.get(value.repositoryRoot);
        if (!repository) {
          repository = {
            workspacePath: value.repositoryRoot,
            workspaceIdentity: workspaceIdentity
              ? (replaceRemoteWorkspaceIdentityPath(workspaceIdentity, value.repositoryRoot) ??
                undefined)
              : undefined,
            memberIds: [],
            currentBranch: value.currentBranch || null,
          };
          grouped.set(value.repositoryRoot, repository);
        }
        repository.memberIds.push(members[index]!.memberId);
      }
      repositories = [...grouped.values()];
      return {
        ...capabilities[0]!,
        supported: capabilities.every((value) => value.supported),
        create: capabilities.every((value) => value.create),
        reason: capabilities.find((value) => !value.create)?.reason,
      };
    };
    void read().then(
      (capabilities) => {
        if (current)
          setState({ scope, key: observationKey, capabilities, repositories, loading: false });
      },
      (error) => {
        if (current)
          setState({ scope, key: observationKey, error: getErrorMessage(error), loading: false });
      },
    );
    return () => {
      current = false;
    };
  }, [
    scope,
    workspacePath,
    workspaceIdentity,
    worktreeService,
    projectExecutionSetService,
    revision,
    sourceFolderPaths,
    collaboration,
    observationKey,
    members,
  ]);
  return {
    scope,
    loading: state.key !== observationKey || state.loading,
    capabilities: state.key === observationKey ? state.capabilities : undefined,
    repositories: state.key === observationKey ? state.repositories : undefined,
    error: state.key === observationKey ? state.error : undefined,
    collaboration,
    folderCount: sourceFolderPaths?.length ?? 1,
  };
}
