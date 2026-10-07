import { useEffect, useState } from "react";
import type { LCodeWorkspaceRef } from "@lcode/shared";
import type { WorktreeBinding } from "@lcode/services";
import { useLCodeSessionService } from "./useLCodeSessionService.js";
import { useWorkspaceServices } from "./useWorkspaceServices.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";

/** Shell 只消费会话 owner 的实际目录；加载失败不将工作树操作回退到原项目。 */
export function useActiveExecutionWorkspace(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string | null,
  remoteSessionId?: string | null,
) {
  const service = useLCodeSessionService(workspacePath, remoteSessionId, workspaceIdentity);
  const { worktreeService } = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const scope = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    workspacePath,
    remoteSessionId ?? null,
    taskId,
  ]);
  const lifecycleRevision = useWorktreeLifecycleStore(
    (state) => state.revisions[workspaceIdentity?.trim() || workspacePath] ?? 0,
  );
  // Git 刷新只更新仓库快照；只有真实工作树生命周期才能使已解析的目录失效。
  const generation = lifecycleRevision;
  const [state, setState] = useState<{
    scope: string;
    generation: number;
    service?: typeof service;
    worktreeService?: typeof worktreeService;
    workspace?: LCodeWorkspaceRef;
    binding?: WorktreeBinding;
    error?: string;
  }>({ scope, generation });
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void (async () => {
      const [snapshot, binding] = await Promise.allSettled([
        service.readSession({
          workspacePath,
          workspaceIdentity,
          sessionId: taskId,
          messageLimit: 1,
        }),
        worktreeService?.getBinding({ workspacePath, workspaceIdentity, taskId }) ??
          Promise.resolve(null),
      ]);
      if (snapshot.status === "rejected") throw snapshot.reason;
      const workspace = snapshot.value.session.workspace;
      if (
        workspace.executionBindingId &&
        (binding.status === "rejected" || !binding.value || binding.value.status !== "ready")
      )
        throw new Error("工作树尚未就绪，请在会话中恢复或检查实际执行目录。");
      if (!cancelled)
        setState({
          scope,
          generation,
          service,
          worktreeService,
          workspace,
          ...(binding.status === "fulfilled" && binding.value ? { binding: binding.value } : {}),
        });
    })().catch((error: unknown) => {
      if (!cancelled)
        setState({
          scope,
          generation,
          service,
          worktreeService,
          error: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [service, worktreeService, workspacePath, workspaceIdentity, taskId, scope, generation]);
  if (!taskId)
    return {
      workspace: {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      } as LCodeWorkspaceRef,
      binding: undefined,
      pending: false,
    };
  // 相同路径的远端 attachment / service 换代也属于 owner 切换，旧结果不能短暂冒充新目录。
  return state.scope === scope &&
    state.generation === generation &&
    state.service === service &&
    state.worktreeService === worktreeService
    ? { ...state, pending: !state.workspace && !state.error }
    : { workspace: undefined, binding: undefined, pending: true };
}
