import { useCallback, useEffect, useState } from "react";
import type { WorktreeIntegrationPreflight } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

export function useWorktreeIntegrationPreflight(bindingId: string, targetBranch: string) {
  const { worktreeService } = useServices();
  const scope = JSON.stringify([bindingId, targetBranch]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    value: WorktreeIntegrationPreflight | null;
    error: string | null;
    loading: boolean;
  }>({ scope, value: null, error: null, loading: true });
  useEffect(() => {
    let current = true;
    setState({ scope, value: null, error: null, loading: true });
    if (!worktreeService) return;
    void worktreeService.getIntegrationPreflight({ bindingId, targetBranch }).then(
      (value) => {
        if (current) setState({ scope, value, error: null, loading: false });
      },
      (error) => {
        if (current)
          setState({ scope, value: null, error: getErrorMessage(error), loading: false });
      },
    );
    // 分支/Host 切换后的旧预检查不能授权新范围；服务执行时仍会重验。
    return () => {
      current = false;
    };
  }, [bindingId, targetBranch, worktreeService, scope, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    ...(state.scope === scope ? state : { value: null, error: null, loading: true }),
    refresh,
  };
}
