import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PatchCodeViewerSource } from "@/lib/codeViewer.js";
import {
  useReviewDiffNavigationStore,
  type ReviewFileActions,
} from "@/store/reviewDiffNavigationStore.js";

export function useReviewDiffNavigation(
  scope: string,
  hide: () => void,
  reopen: () => void,
  actions?: ReviewFileActions,
) {
  const owner = useMemo(() => ({ scope, token: null as string | null }), [scope]);
  const current = useRef({ owner, hide, reopen, actions });
  current.current = { owner, hide, reopen, actions };
  const available = useReviewDiffNavigationStore((state) => Boolean(state.openPreview));
  const clearReturn = useCallback(() => {
    if (owner.token) useReviewDiffNavigationStore.getState().removeReturn(owner.token);
    owner.token = null;
  }, [owner]);
  useEffect(() => clearReturn, [clearReturn]);
  useEffect(() => {
    const nav = useReviewDiffNavigationStore.getState();
    const entry = owner.token ? nav.returns[owner.token] : undefined;
    if (entry && owner.token) nav.registerReturn(owner.token, { ...entry });
  }, [owner, actions?.disabled, actions?.excludedFiles]);
  const openDiff = useCallback(
    (source: PatchCodeViewerSource) => {
      const nav = useReviewDiffNavigationStore.getState();
      if (!nav.openPreview || current.current.owner !== owner) return;
      clearReturn();
      const token = crypto.randomUUID();
      owner.token = token;
      nav.registerReturn(token, {
        reopen: () => {
          if (current.current.owner !== owner || owner.token !== token) return;
          clearReturn();
          current.current.reopen();
        },
        ...(current.current.actions ? { files: () => current.current.actions! } : {}),
      });
      current.current.hide();
      nav.openPreview({ ...source, reviewReturnToken: token });
    },
    [owner, clearReturn],
  );
  return { available, openDiff, clearReturn };
}
