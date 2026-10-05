import { useEffect, useMemo, useState } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useGitLastTurn } from "@/hooks/useGitLastTurn.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionLease,
} from "@/v4/workspaceConnectionRegistry.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import type { GitTurnReviewRequest } from "@/v4/gitTurnReview.js";

export function useSessionGitLastTurn(options: {
  workspacePath: string;
  executionWorkspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null;
  enabled: boolean;
  refreshToken?: unknown;
  reviewTurn?: GitTurnReviewRequest | null;
}) {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.remoteSessionId,
    options.workspaceIdentity,
  );
  const { lcodeAgentService } = resolution.services;
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const scopeKey = JSON.stringify([
    workspaceKey,
    options.workspacePath,
    resolution.remoteSessionId,
    options.sessionId,
  ]);
  const [binding, setBinding] = useState<{
    key: string;
    service: typeof lcodeAgentService;
    connection: WorkspaceConnectionLease;
    session: SessionLease;
  } | null>(null);
  useEffect(() => {
    if (!options.enabled || !options.sessionId || !resolution.rpcReady) return;
    // 审查与聊天必须复用同一 endpoint/原项目的租约；工作树路径只用于执行与展示。
    const connection = acquireWorkspaceConnection(
      {
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
        ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
      },
      lcodeAgentService,
    );
    connection.activateRemoteService();
    const session = connection.layer.acquire(options.sessionId);
    setBinding({ key: scopeKey, service: lcodeAgentService, connection, session });
    return () => {
      session.release();
      connection.release();
    };
  }, [
    lcodeAgentService,
    options.enabled,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    resolution.remoteSessionId,
    resolution.rpcReady,
    scopeKey,
  ]);
  const current =
    options.enabled &&
    resolution.rpcReady &&
    binding?.key === scopeKey &&
    binding.service === lcodeAgentService
      ? binding
      : null;
  const dataset = useGitLastTurn({
    workspacePath: options.executionWorkspacePath,
    lease: current?.session ?? null,
    transport: current?.connection.transport ?? null,
    refreshToken: options.refreshToken,
    reviewTurn: options.reviewTurn,
  });
  const isSelectedTurn = Boolean(options.reviewTurn);
  return useMemo(() => ({ ...dataset, isSelectedTurn }), [dataset, isSelectedTurn]);
}
