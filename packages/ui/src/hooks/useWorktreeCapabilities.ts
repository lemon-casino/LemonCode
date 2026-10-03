import { useEffect, useState } from "react";
import type { WorktreeCapabilities } from "@lcode/services";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useLocalProjectForWorkspace } from "@/LocalProjectsContext.js";

export function useWorktreeCapabilities(
  workspacePath: string,
  workspaceIdentity?: string,
  revision?: string,
) {
  const { worktreeService } = useServices();
  const project = useLocalProjectForWorkspace(workspacePath, workspaceIdentity);
  const sourceFolderPaths = project?.sourceFolderPaths;
  const scope = workspaceIdentity?.trim() || workspacePath;
  const [state, setState] = useState<{
    scope: string;
    capabilities?: WorktreeCapabilities;
    error?: string;
    loading: boolean;
  }>({ scope, loading: true });
  useEffect(() => {
    let current = true;
    if (!worktreeService) {
      setState({ scope, loading: false });
      return;
    }
    setState({ scope, loading: true });
    void worktreeService
      .getCapabilities({ workspacePath, workspaceIdentity, sourceFolderPaths })
      .then(
        (capabilities) => {
          if (current) setState({ scope, capabilities, loading: false });
        },
        (error) => {
          if (current) setState({ scope, error: getErrorMessage(error), loading: false });
        },
      );
    return () => {
      current = false;
    };
  }, [scope, workspacePath, workspaceIdentity, worktreeService, revision, sourceFolderPaths]);
  return state.scope === scope ? state : { scope, loading: true };
}
