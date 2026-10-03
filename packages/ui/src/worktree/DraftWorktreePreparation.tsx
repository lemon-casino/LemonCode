import { useEffect, useRef, useState } from "react";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { useWorktreePreparation } from "@/hooks/useWorktreePreparation.js";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useServices } from "@/hooks/useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { WorktreePreparationCard } from "./WorktreePreparationCard.js";

export function DraftWorktreePreparation({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const scope = workspaceIdentity?.trim() || workspacePath;
  const selection = useDraftExecutionStore((state) => state.drafts[scope]);
  const requestId = selection?.creationEnvelope?.commandId ?? selection?.requestId;
  const state = useWorktreePreparation(workspacePath, workspaceIdentity, requestId);
  const { worktreeService } = useServices();
  const { update } = useProjectExecutionPolicy(workspacePath, workspaceIdentity);
  const [intent, setIntent] = useState<"cancel" | "local" | null>(null);
  const [error, setError] = useState<string>();
  const acted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!intent || state.binding?.status !== "cancelled" || acted.current === requestId) return;
    acted.current = requestId;
    const finish = async () => {
      try {
        if (intent === "local")
          await update({ projectExecutionPreferences: { [scope]: { executionMode: "local" } } });
        if (
          useDraftExecutionStore.getState().drafts[scope]?.creationEnvelope?.commandId === requestId
        )
          useDraftExecutionStore.getState().reset(scope);
      } catch (reason) {
        setError(getErrorMessage(reason));
        acted.current = undefined;
      } finally {
        setIntent(null);
      }
    };
    void finish();
  }, [intent, state.binding?.status, requestId, update, scope]);
  if (!requestId) return null;
  const cancel = async (kind: "cancel" | "local") => {
    const binding = state.binding;
    if (!binding || !worktreeService || intent) return;
    setError(undefined);
    setIntent(kind);
    try {
      const result = await worktreeService.prepare({
        workspacePath,
        workspaceIdentity,
        taskId: binding.taskId,
        requestId: binding.requestId,
        cancel: true,
      });
      state.refresh();
      if (result.status === "ready") {
        setIntent(null);
        throw new Error("Worktree is already ready; its execution location cannot change");
      }
    } catch (reason) {
      setIntent(null);
      setError(getErrorMessage(reason));
    }
  };
  return (
    <WorktreePreparationCard
      binding={state.binding}
      pending={Boolean(selection?.requestId)}
      actionPending={Boolean(intent)}
      error={error ?? state.error ?? selection?.error}
      onCancel={() => void cancel("cancel")}
      onLocal={() => void cancel("local")}
      onRetry={() => useDraftExecutionStore.getState().retry(scope)}
    />
  );
}
