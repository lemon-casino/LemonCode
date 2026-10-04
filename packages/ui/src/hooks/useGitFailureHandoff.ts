import { useCallback, useEffect, useRef, useState } from "react";
import {
  commitReviewNavigationKey,
  useCommitReviewNavigationStore,
} from "@/store/commitReviewNavigationStore.js";

export function useGitFailureDraftReceiver(
  path: string,
  identity: string | undefined,
  sessionId: string | null,
  action: (text: string) => void,
  enabled = true,
) {
  const key = commitReviewNavigationKey(path, identity, sessionId ?? "");
  const latest = useRef({ action, key, enabled });
  latest.current = { action, key, enabled };
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const receiver = {
      token: crypto.randomUUID(),
      action: (text: string) => {
        if (latest.current.key !== key || !latest.current.enabled) return false;
        latest.current.action(text);
        return true;
      },
    };
    useCommitReviewNavigationStore.getState().registerDraftReceiver(key, receiver);
    return () => useCommitReviewNavigationStore.getState().removeDraftReceiver(key, receiver.token);
  }, [key, sessionId, enabled]);
}

export function useGitFailureHandoff(
  path: string,
  identity: string | undefined,
  sessionId: string | undefined,
) {
  const key = commitReviewNavigationKey(path, identity, sessionId ?? "");
  const available = useCommitReviewNavigationStore((state) => Boolean(state.draftReceivers[key]));
  return {
    available,
    transfer: (text: string) => useCommitReviewNavigationStore.getState().transferDraft(key, text),
  };
}

/** 只承载窗口插入意图；正文、附件和模型仍由现有 Composer owner 写入。 */
export function useGitFailureComposerBridge(
  path: string,
  identity: string | undefined,
  sessionId: string | null,
  enabled: boolean,
) {
  const key = commitReviewNavigationKey(path, identity, sessionId ?? "");
  const sequence = useRef(0);
  const [insert, setInsert] = useState<{
    key: string;
    requestId: number;
    text: string;
    mode: "append";
  } | null>(null);
  useGitFailureDraftReceiver(
    path,
    identity,
    sessionId,
    (text) => {
      const requestId = Math.max(Date.now(), sequence.current + 1);
      sequence.current = requestId;
      setInsert({ key, requestId, text, mode: "append" });
    },
    enabled,
  );
  const consume = useCallback(
    (requestId: number) =>
      setInsert((current) => (current?.requestId === requestId ? null : current)),
    [],
  );
  return { request: enabled && insert?.key === key ? insert : null, consume };
}
