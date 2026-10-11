import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeManagementSettings, WorktreeCleanupResult } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";

/** 组件按 scope 挂载；真实配置、名称与清理事实只有目标 Host 服务可以提交。 */
export function useWorktreeManagement(workspacePath: string, workspaceIdentity?: string) {
  const { worktreeService } = useServices();
  const [settings, setSettings] = useState<WorktreeManagementSettings | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<WorktreeCleanupResult>();
  const admission = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    let current = true;
    void worktreeService
      ?.getManagementSettings()
      .then((value) => {
        if (current) setSettings(value);
      })
      .catch((reason) => {
        if (current) setError(getErrorMessage(reason));
      });
    return () => {
      current = false;
      live.current = false;
    };
  }, [worktreeService]);
  const perform = useCallback(
    async (action: () => Promise<void>) => {
      if (admission.current || !worktreeService) return false;
      admission.current = true;
      setPending(true);
      setError(undefined);
      try {
        await action();
        useWorktreeLifecycleStore.getState().invalidate(workspacePath, workspaceIdentity);
        return true;
      } catch (reason) {
        if (live.current) setError(getErrorMessage(reason));
        return false;
      } finally {
        admission.current = false;
        if (live.current) setPending(false);
      }
    },
    [worktreeService, workspacePath, workspaceIdentity],
  );
  return {
    settings,
    error,
    pending,
    cleanupResult,
    save: (patch: Partial<WorktreeManagementSettings>) =>
      perform(async () => {
        const next = await worktreeService!.updateManagementSettings(patch);
        if (live.current) setSettings(next);
      }),
    rename: (bindingId: string, displayName: string) =>
      perform(async () => {
        await worktreeService!.rename({ bindingId, displayName });
      }),
    cleanup: () =>
      perform(async () => {
        const result = await worktreeService!.cleanup();
        if (live.current) setCleanupResult(result);
      }),
  };
}
