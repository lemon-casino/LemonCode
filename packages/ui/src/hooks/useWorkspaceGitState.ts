import type { GitPaneDataset } from "@/hooks/useGitRepository.js";
import { useActiveExecutionWorkspace } from "@/hooks/useActiveExecutionWorkspace.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useSessionGitLastTurn } from "@/hooks/useSessionGitLastTurn.js";
import type { GitTurnReviewRequest } from "@/v4/gitTurnReview.js";

/** App 与组合回归共用的读取编排；Git 版本不得使会话执行目录失效。 */
export function useWorkspaceGitState(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  reviewSessionId?: string | null;
  workspaceRemoteSessionId?: string | null;
  rpcTarget?: { remoteSessionId?: string | null; remoteTarget?: unknown };
  gitRefreshToken: number;
  historyRefreshToken?: number;
  includeExtendedData: boolean;
  livePanelVisible: boolean;
  autoRefreshEnabled: boolean;
  reviewTurn?: GitTurnReviewRequest | null;
  onAutoRefresh: () => void;
}) {
  // 修复依据：旧 App 共用 Git/目录失效版本，监听建立后的刷新反向卸载目录与详情。
  // 实际路径只由会话/Host 身份及工作树生命周期决定，仓库刷新没有更换路径的权限。
  const execution = useActiveExecutionWorkspace(
    options.workspacePath,
    options.workspaceIdentity,
    options.sessionId,
    options.workspaceRemoteSessionId,
  );
  const workspace = execution.workspace;
  const lastTurnDataset: GitPaneDataset = useSessionGitLastTurn({
    workspacePath: options.workspacePath,
    workspaceIdentity: options.workspaceIdentity,
    remoteSessionId: options.rpcTarget?.remoteSessionId ?? null,
    executionWorkspacePath: workspace?.workspacePath ?? "",
    sessionId: options.reviewSessionId ?? options.sessionId,
    enabled: options.includeExtendedData && Boolean(workspace),
    refreshToken: options.historyRefreshToken,
    reviewTurn: options.reviewTurn,
  });
  const gitState = useGitRepository({
    workspacePath: workspace?.workspacePath ?? "",
    workspaceIdentity: workspace?.workspaceIdentity,
    activeTaskId: options.sessionId,
    enabled: Boolean(workspace),
    includeExtendedData: options.includeExtendedData,
    lastTurnDataset,
    refreshToken: options.gitRefreshToken,
    remoteSessionId: options.rpcTarget?.remoteSessionId ?? null,
    remoteTarget: options.rpcTarget?.remoteTarget,
  });
  useGitAutoRefresh({
    workspacePath: workspace?.workspacePath ?? "",
    workspaceIdentity: workspace?.workspaceIdentity,
    remoteSessionId: options.rpcTarget?.remoteSessionId ?? null,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: options.autoRefreshEnabled && Boolean(workspace),
    livePanelVisible: options.livePanelVisible,
    onRefreshGit: options.onAutoRefresh,
  });
  return { execution, gitState };
}
