import { findLocalProjectForWorkspace, type AppSettings } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { restorePersistedRemoteWorkspaceSessions } from "@/root/remoteWorkspaceSessionPersistence.js";
import type { RemoteBrowserNavigationTarget } from "@/store/remoteBrowserNavigationStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import type { RestorableWorkspaceTab, TabStore } from "@/store/tabStore.js";

function resolveWorkspace(
  settings: AppSettings,
  target: RemoteBrowserNavigationTarget,
): RestorableWorkspaceTab | null {
  // 手机 attachment 没有独立远端连接注册表，不能把旧远端 identity 当本地路径重新启动。
  if (target.workspaceIdentity?.trim() || target.remoteSessionId) return null;
  if (target.workspacePurpose === "conversation") return null;
  const project = target.localProjectId
    ? settings.localProjects.find((candidate) => candidate.id === target.localProjectId)
    : findLocalProjectForWorkspace(settings.localProjects, target.workspacePath);
  if (target.localProjectId && !project) return null;
  if (project) return { workspacePath: project.primaryFolderPath, localProjectId: project.id };
  const entry = readPersistedWorkspaceSessionEntries(settings).find(
    (candidate) => candidate.kind === "local" && candidate.workspacePath === target.workspacePath,
  );
  return entry?.kind === "local" ? { ...entry } : null;
}

async function directoryExists(services: IServiceAccessor, path: string): Promise<boolean> {
  try {
    return (await services.fileService.stat({ path })).type === "directory";
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function restoreRemoteBrowserNavigation({
  settings,
  target,
  services,
  tabStoreApi,
  isCurrent = () => true,
}: {
  settings: AppSettings;
  target: RemoteBrowserNavigationTarget | null;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  isCurrent?: () => boolean;
}): Promise<void> {
  let workspace = target ? resolveWorkspace(settings, target) : null;
  let taskId: string | null = null;
  if (workspace) {
    const [exists, meta] = await Promise.all([
      directoryExists(services, workspace.workspacePath),
      target?.taskId
        ? services.lcodeTaskService.getTaskMeta({
            workspacePath: workspace.workspacePath,
            taskId: target.taskId,
          })
        : Promise.resolve(null),
    ]);
    if (!exists) workspace = null;
    else taskId = meta ? target!.taskId : null;
  }
  if (!workspace) {
    const { path } = await services.fileService.ensureConversationWorkspace();
    workspace = { workspacePath: path, workspacePurpose: "conversation" };
    // 默认对话同样可以选中历史会话；必须以当前 Host canonical cwd 验证。
    if (
      target?.workspacePurpose === "conversation" &&
      !target.workspaceIdentity?.trim() &&
      !target.remoteSessionId &&
      target.workspacePath === path &&
      target.taskId
    ) {
      const meta = await services.lcodeTaskService.getTaskMeta({
        workspacePath: path,
        taskId: target.taskId,
      });
      taskId = meta ? target.taskId : null;
    }
  }
  if (!isCurrent()) return;
  const currentSettings = {
    ...settings,
    lastWorkspaceSession: readPersistedWorkspaceSessionEntries(settings).filter(
      (entry) =>
        entry.kind !== "local" ||
        !entry.localProjectId ||
        settings.localProjects.some((project) => project.id === entry.localProjectId),
    ),
  };
  restorePersistedRemoteWorkspaceSessions({
    settings: currentSettings,
    tabStoreApi,
    allowRemoteWorkspaceRestore: false,
    ...(workspace.workspacePurpose === "conversation"
      ? { conversationWorkspacePath: workspace.workspacePath }
      : {}),
  });
  tabStoreApi.getState().addTab(workspace.workspacePath, workspace);
  const sessions = useLCodeSessionStore.getState();
  if (taskId)
    sessions.setActiveTaskId(workspace.workspacePath, taskId, workspace.workspaceIdentity);
  else sessions.startDraft(workspace.workspacePath, undefined, workspace.workspaceIdentity);
}
