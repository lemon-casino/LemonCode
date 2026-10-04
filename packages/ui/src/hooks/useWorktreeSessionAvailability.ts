import { useEffect, useState } from "react";
import { useServices } from "./useServices.js";

/** 管理不需要恢复会话；只读索引判断审核入口，避免对已删除会话发起 subscribe。 */
export function useWorktreeSessionAvailability(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  revision: number,
) {
  const { lcodeTaskService } = useServices();
  const scope = JSON.stringify([workspaceIdentity?.trim() || workspacePath, taskId]);
  const [state, setState] = useState<{
    scope: string;
    status: "checking" | "available" | "missing" | "error";
  }>({ scope, status: "checking" });
  useEffect(() => {
    let active = true;
    setState({ scope, status: "checking" });
    void lcodeTaskService.getTaskMeta({ workspacePath, workspaceIdentity, taskId }).then(
      (meta) => {
        if (active) setState({ scope, status: meta ? "available" : "missing" });
      },
      () => {
        if (active) setState({ scope, status: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [lcodeTaskService, scope, workspacePath, workspaceIdentity, taskId, revision]);
  return state.scope === scope ? state.status : "checking";
}
