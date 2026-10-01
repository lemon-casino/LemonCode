import { useEffect, useState } from "react";
import { useServices } from "./useServices.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { collectSessionCommitFilePaths } from "@/git-action-menu/sessionCommitMessageFiles.js";
import { filterGitFilesByCurrentSession } from "@/git-action-menu/currentSessionFileScope.js";
import { logger } from "@/logger.js";

export function useSessionCommitMessageFiles(options: {
  enabled: boolean;
  scopeKey: string;
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  candidatePathsKey: string;
  childSessionIdsKey: string;
  refreshKey: string;
}): string[] {
  const {
    enabled,
    scopeKey,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    candidatePathsKey,
    childSessionIdsKey,
    refreshKey,
  } = options;
  const { gitService, lcodeAgentService } = useServices();
  const { rowsRange, fileChanges } = useV4Conversation();
  const [result, setResult] = useState<{ scopeKey: string; paths: string[] } | null>(null);
  useEffect(() => {
    if (!enabled || !sessionId) {
      setResult(null);
      return;
    }
    let alive = true;
    void (async () => {
      const candidates = new Set<string>(JSON.parse(candidatePathsKey) as string[]);
      const children = new Set<string>(JSON.parse(childSessionIdsKey) as string[]);
      if (rowsRange) {
        // 工作流主会话常没有 fileChanges，读取宿主确认的子任务目录补足，不能扩大成整个仓库。
        const directory = await lcodeAgentService.listSessionSubagents({
          workspacePath,
          workspaceIdentity,
          sessionId,
          remoteSessionId: remoteSessionId ?? undefined,
        });
        for (const id of directory.childSessionIds) children.add(id);
        const paths = await collectSessionCommitFilePaths(
          { rowsRange, fileChanges },
          [sessionId, ...children],
          () => alive,
        );
        for (const path of paths) candidates.add(path);
      }
      if (!alive) return;
      const current = await gitService.refresh({ workspacePath });
      if (!alive) return;
      const paths =
        candidates.size && current.summary.isGitAvailable && current.summary.isRepository
          ? filterGitFilesByCurrentSession({
              files: [...current.stagedChanges, ...current.unstagedChanges],
              currentSessionFilePaths: [...candidates],
              gitSummary: current.summary,
              workspacePath,
            }).map((file) => file.path)
          : [];
      setResult({ scopeKey, paths: [...new Set(paths)] });
    })().catch((error: unknown) => {
      if (!alive) return;
      setResult({ scopeKey, paths: [] });
      logger.lifecycle.warn("[v4-pane] 手动提交纪要文件范围读取失败", {
        sessionId,
        error: String(error),
      });
    });
    return () => {
      alive = false;
    };
  }, [
    enabled,
    scopeKey,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    candidatePathsKey,
    childSessionIdsKey,
    refreshKey,
    rowsRange,
    fileChanges,
    gitService,
    lcodeAgentService,
  ]);
  return enabled && result?.scopeKey === scopeKey ? result.paths : [];
}
