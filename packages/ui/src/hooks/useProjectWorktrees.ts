import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeBinding } from "@lcode/services";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";

export function useProjectWorktrees(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  enabled: boolean,
) {
  const { worktreeService } = useServices();
  const scope = workspaceIdentity?.trim() || workspacePath;
  const revision = useWorktreeLifecycleStore((state) => state.revisions[scope]);
  const ticket = useRef(0);
  const [state, setState] = useState<{
    scope: string;
    bindings: WorktreeBinding[];
    loading: boolean;
    error?: string;
  }>({ scope, bindings: [], loading: false });
  const refresh = useCallback(async () => {
    const ownTicket = ++ticket.current;
    if (!worktreeService) return;
    setState((previous) => ({
      scope,
      bindings: previous.scope === scope ? previous.bindings : [],
      loading: true,
    }));
    try {
      const bindings = await worktreeService.list({ workspacePath, workspaceIdentity });
      if (ownTicket === ticket.current) setState({ scope, bindings, loading: false });
    } catch (error) {
      if (ownTicket === ticket.current)
        // 刷新异常不卸载已打开的管理弹窗；保留上次读取直到 owner 返回新结果。
        setState((previous) => ({
          scope,
          bindings: previous.scope === scope ? previous.bindings : [],
          loading: false,
          error: getErrorMessage(error),
        }));
    }
  }, [scope, workspacePath, workspaceIdentity, worktreeService]);
  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      ticket.current++;
    };
  }, [enabled, refresh, revision]);
  return {
    ...(state.scope === scope ? state : { scope, bindings: [], loading: true }),
    available: Boolean(worktreeService),
    refresh,
  };
}
