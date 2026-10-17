import { useEffect, useState } from "react";
import type { ProjectContextSnapshot, SidebarEntryRef } from "@lcode/shared";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";

/** 读取会话已接受输入的冻结事实；不把当前可编辑的项目定义冒充历史执行范围。 */
export function useProjectScopeInspection(target: Extract<SidebarEntryRef, { kind: "task" }>) {
  const resolution = useWorkspaceServicesResolution(
    target.workspace.workspacePath,
    undefined,
    target.workspace.workspaceIdentity,
  );
  const [state, setState] = useState<{
    context?: ProjectContextSnapshot;
    loading: boolean;
    error?: string;
  }>({ loading: true });
  useEffect(() => {
    setState({ loading: true });
    if (!resolution.rpcReady) {
      setState({ loading: false, error: "Source disconnected" });
      return;
    }
    let active = true;
    const lease = acquireWorkspaceConnection(
      { ...target.workspace, remoteSessionId: resolution.remoteSessionId ?? undefined },
      resolution.services.lcodeAgentService,
    );
    lease.activateRemoteService();
    void (async () => {
      let beforeRowId: number | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const page = await lease.transport.rowsRange({
          sessionId: target.taskId,
          limit: 100,
          beforeRowId,
        });
        if (!active) return;
        const input = [...page.rows]
          .reverse()
          .find((row) => row.kind === "userInput" && row.projectContext);
        if (input?.kind === "userInput") {
          setState({ context: input.projectContext, loading: false });
          return;
        }
        if (!page.hasMore || !page.rows.length) break;
        const next = page.rows[0]!.rowId;
        if (beforeRowId !== undefined && next >= beforeRowId)
          throw new Error("Conversation history did not advance");
        beforeRowId = next;
      }
      if (active) setState({ loading: false });
    })().catch((error) => {
      if (active)
        setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [resolution.rpcReady, resolution.services, resolution.remoteSessionId, target]);
  return state;
}
