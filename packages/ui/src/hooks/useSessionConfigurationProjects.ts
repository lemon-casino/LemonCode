import { useMemo } from "react";
import {
  buildRemoteWorkspaceIdentity,
  findProjectDefinition,
  type AppSettings,
} from "@lcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { getRemoteWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { getPathLeaf } from "@/lib/path.js";
import { isWorktreeSidebarWorkspace } from "@/lib/worktreeSidebar.js";
import { useSettings } from "./useSettingService.js";
import { useSidebarWorktrees, type SidebarWorktreeEntry } from "./useSidebarWorktrees.js";

export type SessionConfigurationProject = Pick<
  WorkspaceTabState,
  | "workspacePath"
  | "workspaceIdentity"
  | "remoteSessionId"
  | "remoteTarget"
  | "label"
  | "localProjectId"
>;

export const sessionConfigurationProjectKey = (project: SessionConfigurationProject) =>
  JSON.stringify([project.workspaceIdentity?.trim() || project.workspacePath]);

/** 只派生配置 scope；连接和设置的所有权仍属于原注册表与服务。 */
export function resolveSessionConfigurationProjects({
  settings,
  workspaceTabs,
  worktreeEntries,
  sessionsById,
  sessionIdByWorkspaceIdentity,
}: {
  settings: AppSettings | null;
  workspaceTabs: WorkspaceTabState[];
  worktreeEntries: SidebarWorktreeEntry[];
  sessionsById: Record<string, RemoteWorkspaceSession>;
  sessionIdByWorkspaceIdentity: Record<string, string>;
}): SessionConfigurationProject[] {
  const bindings = worktreeEntries.map((entry) => entry.binding);
  const projects = new Map<string, SessionConfigurationProject>();
  const add = (project: SessionConfigurationProject) => {
    const workspaceIdentity =
      project.workspaceIdentity?.trim() ||
      (project.remoteTarget
        ? buildRemoteWorkspaceIdentity(project.workspacePath, project.remoteTarget)
        : undefined);
    const normalized = { ...project, workspaceIdentity };
    if (isWorktreeSidebarWorkspace(normalized, bindings)) return;
    const key = sessionConfigurationProjectKey(normalized);
    // 原因：tab 未携带 target 时曾覆盖保存的远端元数据；保留来源元数据，实时路由最后按 identity 绑定。
    projects.set(key, {
      ...projects.get(key),
      ...normalized,
      remoteTarget: normalized.remoteTarget ?? projects.get(key)?.remoteTarget,
    });
  };
  for (const path of settings?.recentProjects ?? [])
    add({ workspacePath: path, label: getPathLeaf(path) || path });
  for (const project of settings?.localProjects ?? [])
    add({ workspacePath: project.primaryFolderPath, label: project.name });
  // 原因：配置原先只遍历打开的 tab，保存但未打开的 SSH/WSL/Docker 项目无法选择。
  // 历史只提供身份和展示数据，不能据此连接或把远端模型替换为本地模型。
  for (const entry of getRemoteWorkspaceSessionEntries(settings ?? {}))
    add({
      workspacePath: entry.workspacePath,
      workspaceIdentity: entry.workspaceIdentity,
      remoteTarget: entry.target,
      label: getPathLeaf(entry.workspacePath) || entry.workspacePath,
    });
  for (const session of Object.values(sessionsById)) {
    if (!session.workspacePath || !session.workspaceIdentity?.trim()) continue;
    add({
      workspacePath: session.workspacePath,
      workspaceIdentity: session.workspaceIdentity,
      remoteTarget: session.target,
      remoteSessionId: session.sessionId,
      label: getPathLeaf(session.workspacePath) || session.workspacePath,
    });
  }
  for (const tab of workspaceTabs) {
    if (tab.workspacePurpose === "conversation") continue;
    const local =
      !tab.workspaceIdentity && !tab.remoteTarget && !tab.remoteSessionId
        ? settings?.localProjects?.find((item) => item.primaryFolderPath === tab.workspacePath)
        : undefined;
    add({ ...tab, label: local?.name || tab.label });
  }
  for (const { origin } of worktreeEntries) add(origin);
  return [...projects.values()].map((project) => {
    const sessionId = project.workspaceIdentity
      ? sessionIdByWorkspaceIdentity[project.workspaceIdentity]
      : undefined;
    const definition = findProjectDefinition(
      settings?.projectDefinitions?.projects ?? settings?.localProjects ?? [],
      project.workspacePath,
      project.workspaceIdentity,
    );
    const normalized = definition
      ? { ...project, label: definition.name, localProjectId: definition.id }
      : project;
    return sessionId && sessionsById[sessionId]
      ? { ...normalized, remoteSessionId: sessionId }
      : normalized;
  });
}

export function useSessionConfigurationProjects(workspaceTabs: WorkspaceTabState[]) {
  const { settings } = useSettings();
  const trees = useSidebarWorktrees(workspaceTabs);
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  return useMemo(
    () =>
      resolveSessionConfigurationProjects({
        settings,
        workspaceTabs,
        worktreeEntries: trees.entries,
        sessionsById,
        sessionIdByWorkspaceIdentity,
      }),
    [settings, workspaceTabs, trees.entries, sessionsById, sessionIdByWorkspaceIdentity],
  );
}
