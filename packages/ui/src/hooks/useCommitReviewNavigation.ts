import { useEffect, useRef } from "react";
import {
  commitReviewNavigationKey,
  useCommitReviewNavigationStore,
} from "@/store/commitReviewNavigationStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";

export function useCommitReviewNavigation(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | undefined,
  enabled: boolean,
  onOpen: () => void,
) {
  const key = commitReviewNavigationKey(workspacePath, workspaceIdentity, sessionId ?? "");
  const request = useCommitReviewNavigationStore((state) => state.request);
  const latestOpen = useRef(onOpen);
  latestOpen.current = onOpen;
  useEffect(() => {
    if (enabled && request?.key === key && useCommitReviewNavigationStore.getState().consume(key))
      latestOpen.current();
  }, [enabled, key, request]);
}

export function useOpenCommitReview(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
  selectSession?: (sessionId: string) => void,
) {
  return () => {
    // 沿原导航选择已有会话，审核仍由当前会话的 GitActionMenu 打开，不挂载第二个控制器。
    if (selectSession) selectSession(sessionId);
    else
      useLCodeSessionStore.getState().setActiveTaskId(workspacePath, sessionId, workspaceIdentity);
    useCommitReviewNavigationStore
      .getState()
      .open(commitReviewNavigationKey(workspacePath, workspaceIdentity, sessionId));
  };
}

export function useWorktreeConflictResolver(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  action: (operationId: string) => Promise<void>,
) {
  const key = commitReviewNavigationKey(workspacePath, workspaceIdentity, sessionId ?? "");
  useEffect(() => {
    if (!sessionId) return;
    const resolver = { token: crypto.randomUUID(), action };
    useCommitReviewNavigationStore.getState().registerResolver(key, resolver);
    return () => useCommitReviewNavigationStore.getState().removeResolver(key, resolver.token);
  }, [action, key, sessionId]);
}
