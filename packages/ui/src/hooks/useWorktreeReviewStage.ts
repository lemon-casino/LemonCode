import { useEffect, useRef } from "react";
import type { WorktreeBinding, WorktreeIntegration } from "@lcode/services";
import type { useReviewWorkspaceState } from "./useReviewWorkspaceState.js";
import { worktreeReviewStage } from "@/worktree/worktreeReviewStages.js";

export function useWorktreeReviewStage(
  shared: ReturnType<typeof useReviewWorkspaceState>,
  binding: WorktreeBinding | null,
  operation: WorktreeIntegration | null,
  loading: boolean,
) {
  const currentStage = binding?.status === "archived" ? 0 : worktreeReviewStage(operation);
  const phaseKey = `${operation?.id ?? "setup"}/${currentStage}`;
  const { data, status, read, patch } = shared;
  const priorPhase = useRef<string | null>(null);
  useEffect(() => {
    if (status === "loading" || !binding || loading || priorPhase.current === phaseKey) return;
    priorPhase.current = phaseKey;
    if (read().data.worktreeView?.key !== phaseKey)
      patch({
        worktreeView: { key: phaseKey, stage: currentStage },
        integrationId: operation?.id ?? null,
      });
  }, [phaseKey, currentStage, operation?.id, binding, loading, status, patch, read]);
  const stage =
    data.worktreeView?.key === phaseKey
      ? Math.min(data.worktreeView.stage, currentStage)
      : currentStage;
  return {
    stage,
    currentStage,
    phaseKey,
    readOnly: stage < currentStage,
    setView: (value: typeof data.worktreeView) => patch({ worktreeView: value }),
  };
}
