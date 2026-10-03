import { useCallback, useEffect, useRef, useState } from "react";
import type { GitLocalBranchListResult } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

/** 基线只读，不复用包含 switchBranch 副作用的交互 hook。 */
export function useWorktreeBaseBranches(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  enabled: boolean,
) {
  const { gitService } = useServices();
  const scope = workspaceIdentity?.trim() || workspacePath;
  const ticket = useRef(0);
  const [state, setState] = useState<{
    scope: string;
    result?: GitLocalBranchListResult;
    loading: boolean;
    error?: string;
  }>({ scope, loading: false });
  const refresh = useCallback(async () => {
    const current = ++ticket.current;
    setState({ scope, loading: true });
    try {
      const result = await gitService.getLocalBranches({ workspacePath, workspaceIdentity });
      if (ticket.current === current) setState({ scope, result, loading: false });
    } catch (error) {
      if (ticket.current === current)
        setState({ scope, loading: false, error: getErrorMessage(error) });
    }
  }, [gitService, scope, workspaceIdentity, workspacePath]);
  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      ticket.current++;
    };
  }, [enabled, refresh]);
  return { ...(state.scope === scope ? state : { scope, loading: enabled }), refresh };
}
