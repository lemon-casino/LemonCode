import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useServices } from "./useServices.js";
import { getReviewWorkspaceProjection } from "@/store/reviewWorkspaceState.js";
import { useCallback, type SetStateAction } from "react";
import type { GitReviewWorkspaceData } from "@lcode/shared";

export function useReviewWorkspaceState(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
) {
  const { gitService } = useServices();
  const store = useMemo(
    () => getReviewWorkspaceProjection(gitService, { workspacePath, workspaceIdentity, scopeId }),
    [gitService, workspacePath, workspaceIdentity, scopeId],
  );
  const projection = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void store.refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [store]);
  const set = useCallback(
    <K extends keyof GitReviewWorkspaceData>(
      field: K,
      action: SetStateAction<GitReviewWorkspaceData[K]>,
    ) => {
      const value =
        typeof action === "function"
          ? (action as (previous: GitReviewWorkspaceData[K]) => GitReviewWorkspaceData[K])(
              store.getSnapshot().data[field],
            )
          : action;
      store.patch({ [field]: value });
    },
    [store],
  );
  return {
    ...projection,
    set,
    patch: store.patch,
    flush: store.flush,
    refresh: store.refresh,
    retry: store.retry,
    resolve: store.resolve,
    read: store.getSnapshot,
  };
}
