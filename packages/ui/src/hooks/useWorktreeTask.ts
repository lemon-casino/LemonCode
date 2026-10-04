import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeBinding, WorktreeIntegration } from "@lcode/services";
import { useServices } from "./useServices.js";
import { getCheckoutOperationErrorMessage } from "@/lib/checkoutOperationError.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";

export function useWorktreeTask(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string | null,
  revision?: string,
) {
  const { worktreeService, gitService } = useServices();
  const { intl } = useLCodeIntl();
  const directoryBusyMessage = intl.formatMessage({ id: "git.commitWorkflow.directoryBusy" });
  const targetBlockedMessage = intl.formatMessage({ id: "worktree.targetLocalChanges" });
  const targetChangedMessage = intl.formatMessage({ id: "worktree.targetChangedReview" });
  const outputLimitMessage = intl.formatMessage({ id: "worktree.archiveOutputLimit" });
  const timeoutMessage = intl.formatMessage({ id: "worktree.operationTimedOut" });
  const runningMessage = intl.formatMessage({ id: "worktree.deleteRunning" });
  const deleteChangedMessage = intl.formatMessage({ id: "worktree.deleteChanged" });
  const describeError = useCallback(
    (error: unknown) => {
      const message = getCheckoutOperationErrorMessage(error, directoryBusyMessage);
      if (message.startsWith("Git worktree command output exceeded limit:"))
        return outputLimitMessage;
      if (message.startsWith("Git worktree command timed out:")) return timeoutMessage;
      if (message === "Worktree integration is running; stop it before deleting")
        return runningMessage;
      if (message === "Task branch changed during deletion; preserve the newer work")
        return deleteChangedMessage;
      const marker = "Target checkout cannot be updated without overwriting local changes.";
      if (
        message === "Target HEAD changed; create and review a new integration" ||
        message === "Target changed during validation"
      )
        return targetChangedMessage;
      if (message === "Target has uncommitted or untracked changes; publication is blocked")
        return targetBlockedMessage;
      return message.startsWith(marker)
        ? `${targetBlockedMessage}${message.slice(marker.length)}`
        : message;
    },
    [
      directoryBusyMessage,
      targetBlockedMessage,
      targetChangedMessage,
      outputLimitMessage,
      timeoutMessage,
      runningMessage,
      deleteChangedMessage,
    ],
  );
  const scope = `${workspaceIdentity?.trim() || workspacePath}\0${taskId ?? ""}`;
  const ticket = useRef(0);
  const [state, setState] = useState<{
    scope: string;
    binding: WorktreeBinding | null;
    operation: WorktreeIntegration | null;
    error?: string;
    rawError?: string;
    loading: boolean;
  }>({ scope, binding: null, operation: null, loading: false });
  const [pending, setPending] = useState(false);
  const current =
    state.scope === scope ? state : { scope, binding: null, operation: null, loading: true };
  const refresh = useCallback(async () => {
    const ownTicket = ++ticket.current;
    if (!taskId || !worktreeService) {
      setState({ scope, binding: null, operation: null, loading: false });
      return;
    }
    try {
      const binding = await worktreeService.getBinding({
        workspacePath,
        workspaceIdentity,
        taskId,
      });
      const operation = binding?.latestIntegrationId
        ? await worktreeService.getIntegration({ operationId: binding.latestIntegrationId })
        : null;
      if (ticket.current === ownTicket) setState({ scope, binding, operation, loading: false });
    } catch (error) {
      if (ticket.current === ownTicket)
        setState((previous) => ({
          ...(previous.scope === scope ? previous : { binding: null, operation: null }),
          scope,
          loading: false,
          error: describeError(error),
          rawError: getErrorMessage(error),
        }));
    }
  }, [scope, taskId, workspacePath, workspaceIdentity, worktreeService, describeError]);
  useEffect(() => {
    void refresh();
    return () => {
      ticket.current++;
    };
  }, [refresh, revision]);
  const perform = useCallback(
    async (action: () => Promise<unknown>) => {
      if (pending) return false;
      const ownScope = scope;
      setPending(true);
      setState((previous) => ({ ...previous, error: undefined, rawError: undefined }));
      try {
        await action();
        useWorktreeLifecycleStore.getState().invalidate(workspacePath, workspaceIdentity);
        await refresh();
        return true;
      } catch (error) {
        // mutation 失败可能发生在副作用已完成之后；先对账持久阶段，再保留错误供用户重试。
        useWorktreeLifecycleStore.getState().invalidate(workspacePath, workspaceIdentity);
        await refresh();
        setState((previous) =>
          previous.scope === ownScope
            ? { ...previous, error: describeError(error), rawError: getErrorMessage(error) }
            : previous,
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [pending, refresh, scope, workspacePath, workspaceIdentity, describeError],
  );
  return { ...current, pending, refresh, perform, worktreeService, gitService, describeError };
}
