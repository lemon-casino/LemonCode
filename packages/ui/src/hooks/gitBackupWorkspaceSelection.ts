import {
  gitBackupWorkspaceKey,
  type GitBackupWorkspaceTarget,
  type IGitBackupService,
} from "@lcode/services";
import {
  resolveWorkspaceRemoteSessionId,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";

interface WorkspaceCandidate extends GitBackupWorkspaceTarget {
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

export function selectGitBackupWorkspaceCandidates(
  workspaces: readonly WorkspaceCandidate[],
  connectionKind: "local-ready" | "remote-ready" | "remote-waiting",
  service: IGitBackupService | null,
  remoteSessionId: string | null,
  state: WorkspaceServiceResolverState<{ gitBackupService?: IGitBackupService }>,
): GitBackupWorkspaceTarget[] {
  if (!service || connectionKind === "remote-waiting") return [];
  return workspaces
    .filter((workspace) => {
      const remote = Boolean(
        workspace.workspaceIdentity?.trim() || workspace.remoteSessionId || workspace.remoteTarget,
      );
      if (connectionKind === "local-ready") return !remote;
      // 只认可 attachment/identity 绑定；旧标签仅有路径时不能借用另一 Host 的备份服务。
      if (!remote || (!workspace.workspaceIdentity?.trim() && !workspace.remoteSessionId))
        return false;
      const sessionId = resolveWorkspaceRemoteSessionId(workspace, state);
      return Boolean(
        sessionId &&
        (sessionId === remoteSessionId ||
          state.sessionsById[sessionId]?.services.gitBackupService === service),
      );
    })
    .map(toTarget);
}

function toTarget(workspace: GitBackupWorkspaceTarget): GitBackupWorkspaceTarget {
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  return {
    workspacePath: workspace.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
}

export function collectGitBackupWorkspaces(
  candidates: readonly GitBackupWorkspaceTarget[],
  current: GitBackupWorkspaceTarget | null,
  selected: readonly GitBackupWorkspaceTarget[],
): GitBackupWorkspaceTarget[] {
  const result = new Map<string, GitBackupWorkspaceTarget>();
  for (const workspace of [...candidates, ...(current ? [current] : []), ...selected]) {
    const key = gitBackupWorkspaceKey(workspace);
    if (workspace.workspacePath.trim() && !result.has(key)) result.set(key, toTarget(workspace));
  }
  return [...result.values()];
}
