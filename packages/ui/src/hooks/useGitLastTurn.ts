import { useEffect, useState } from "react";
import type { GitPaneDataset } from "@/hooks/useGitRepository.js";
import { logger } from "@/logger.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import type { GitTurnReviewRequest } from "@/v4/gitTurnReview.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import {
  buildGitLastTurnDataset,
  findLastCompletedAgentTurn,
  findReviewTurnHeader,
  readLastCompletedAgentTurn,
} from "@/v4/gitLastTurn.js";

/** 读取共享投影和既有历史查询；不另存 per-turn 会话状态。 */
export function useGitLastTurn(options: {
  workspacePath: string;
  lease: SessionLease | null;
  transport: ConversationTransport | null;
  refreshToken?: unknown;
  reviewTurn?: GitTurnReviewRequest | null;
}): GitPaneDataset {
  const { workspacePath, lease, transport, refreshToken, reviewTurn } = options;
  const projection = useConversationProjection(lease);
  const snapshot = projection.snapshot;
  const header = reviewTurn
    ? findReviewTurnHeader(snapshot?.rows.window ?? [], reviewTurn.header)
    : snapshot
      ? findLastCompletedAgentTurn(snapshot.rows.window)
      : null;
  // chunk/revision 增长不能反复拉上一轮完整 patch；终态、摘要、撤销和纪元才使历史结果失效。
  const queryKey = JSON.stringify([
    snapshot?.logEpoch,
    reviewTurn?.logEpoch,
    header
      ? [header.rowId, header.entityId, header.state, header.fileChanges]
      : snapshot?.rows.window.at(-1)?.turnId,
  ]);
  const [view, setView] = useState<{
    lease: SessionLease;
    key: string;
    workspacePath: string;
    dataset: GitPaneDataset;
  } | null>(null);

  useEffect(() => {
    if (!lease || !transport || projection.syncing || !lease.store.getState().snapshot) return;
    let disposed = false;
    const setDataset = (dataset: GitPaneDataset) => {
      if (!disposed) setView({ lease, key: queryKey, workspacePath, dataset });
    };
    setDataset({ ...buildGitLastTurnDataset(workspacePath, null), loading: true });
    void (async () => {
      const current = lease.store.getState().snapshot!;
      if (reviewTurn && reviewTurn.logEpoch !== current.logEpoch) {
        throw new Error(
          "The selected turn belongs to an earlier conversation history; reopen review from the conversation",
        );
      }
      const turn =
        (reviewTurn ? findReviewTurnHeader(current.rows.window, reviewTurn.header) : null) ??
        (await readLastCompletedAgentTurn({
          sessionId: lease.sessionId,
          logEpoch: current.logEpoch,
          rows: current.rows.window,
          hasMore:
            current.rows.firstRowId !== null &&
            (current.rows.window[0]?.rowId ?? 0) > current.rows.firstRowId,
          rowsRange: (params) => transport.rowsRange(params),
          cancelled: () => disposed,
        }));
      if (disposed) return;
      if (!turn?.fileChanges?.files || turn.fileChanges.state === "reverted") {
        setDataset(buildGitLastTurnDataset(workspacePath, null));
        return;
      }
      const authority = lease.store.getState().snapshot;
      if (!authority || authority.logEpoch !== current.logEpoch) return;
      if (!turn.entityId)
        throw new Error(
          "File changes require a conversation entity ID; reconnect with an updated Host",
        );
      const details = await transport.fileChanges({
        sessionId: lease.sessionId,
        target: { rowId: turn.rowId, entityId: turn.entityId },
        baseRevision: authority.revision,
        baseLogEpoch: authority.logEpoch,
      });
      setDataset(buildGitLastTurnDataset(workspacePath, details));
    })().catch((error: unknown) => {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[useGitLastTurn] 读取上一轮文件改动失败", {
        sessionId: lease.sessionId,
        error: message,
      });
      setDataset({ ...buildGitLastTurnDataset(workspacePath, null), error: message });
      // 查询遇到过期权威水位时复用共享 store 的恢复；不重放命令或自己维护另一套订阅。
      if (shouldResyncForStaleAuthority(error)) lease.store.recoverFromStaleAuthority();
    });
    return () => {
      disposed = true;
    };
  }, [
    lease,
    projection.status,
    projection.syncing,
    queryKey,
    refreshToken,
    reviewTurn,
    transport,
    workspacePath,
  ]);

  if (!lease) return buildGitLastTurnDataset(workspacePath, null);
  if (projection.status === "error") {
    return { ...buildGitLastTurnDataset(workspacePath, null), error: projection.lastError };
  }
  return view?.lease === lease && view.key === queryKey && view.workspacePath === workspacePath
    ? view.dataset
    : { ...buildGitLastTurnDataset(workspacePath, null), loading: true };
}
