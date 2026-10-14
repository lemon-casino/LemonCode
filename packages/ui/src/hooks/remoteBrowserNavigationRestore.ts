import { findLocalProjectForWorkspace, type AppSettings } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { restorePersistedRemoteWorkspaceSessions } from "@/root/remoteWorkspaceSessionPersistence.js";
import type { RemoteBrowserNavigationTarget } from "@/store/remoteBrowserNavigationStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { resolveRemoteWorkspaceSessionIdentity } from "@/lib/remoteWorkspaceHistory.js";
import type { RestorableWorkspaceTab, TabStore } from "@/store/tabStore.js";

function resolveWorkspace(
  settings: AppSettings,
  target: RemoteBrowserNavigationTarget,
): RestorableWorkspaceTab | null {
  if (target.workspaceIdentity?.trim() || target.remoteSessionId) {
    const entry = readPersistedWorkspaceSessionEntries(settings).find(
      (candidate) =>
        candidate.kind === "remote" &&
        resolveRemoteWorkspaceSessionIdentity(candidate) === target.workspaceIdentity?.trim(),
    );
    const state = useRemoteWorkspaceSessionStore.getState();
    const sessionId = target.workspaceIdentity
      ? state.sessionIdByWorkspaceIdentity[target.workspaceIdentity.trim()]
      : undefined;
    const session = sessionId ? state.sessionsById[sessionId] : undefined;
    // identity 是轻绑定；session 由 Host 当前目录解析，旧浏览位置不能锁住上一代 session。
    return session && (entry?.kind === "remote" || session.workspacePath === target.workspacePath)
      ? {
          workspacePath: session.workspacePath ?? entry!.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          remoteSessionId: sessionId,
          remoteTarget: session.target ?? (entry?.kind === "remote" ? entry.target : undefined),
        }
      : null;
  }
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
    const targetServices = workspace.remoteSessionId
      ? useRemoteWorkspaceSessionStore.getState().sessionsById[workspace.remoteSessionId]?.services
      : services;
    if (!targetServices) throw new Error("remote workspace source unavailable");
    const [exists, meta] = await Promise.all([
      directoryExists(targetServices, workspace.workspacePath),
      target?.taskId
        ? targetServices.lcodeTaskService.getTaskMeta({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
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
    // 禁止新建远端连接不等于隐藏桌面已有远端项目；恢复只产生断连占位，代理来自目录。
    allowRemoteWorkspaceRestore: true,
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
