import { useCallback, useEffect, useState } from "react";
import type { LCodeWorkspaceRef } from "@lcode/shared";
import type { WorktreeBinding } from "@lcode/services";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";

export interface ExecutionWorkspaceView {
  workspace?: LCodeWorkspaceRef;
  binding?: WorktreeBinding;
  error?: string;
  pending: boolean;
  retry: () => void;
}

/** Shell 只消费会话 owner 的实际目录；加载失败不将工作树操作回退到原项目。 */
export function useActiveExecutionWorkspace(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string | null,
  remoteSessionId?: string | null,
): ExecutionWorkspaceView {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const {
    lcodeSessionService: service,
    lcodeAgentService,
    worktreeService,
    projectExecutionSetService,
  } = resolution.services;
  const scope = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    workspacePath,
    resolution.remoteSessionId,
    taskId,
  ]);
  const lifecycleRevision = useWorktreeLifecycleStore(
    (state) => state.revisions[workspaceIdentity?.trim() || workspacePath] ?? 0,
  );
  // Git 刷新只更新仓库快照；目录随工作树生命周期及下方共享会话恢复闸门重新验证。
  const generation = lifecycleRevision;
  const [retryRevision, setRetryRevision] = useState(0);
  const retry = useCallback(() => setRetryRevision((value) => value + 1), []);
  const [state, setState] = useState<{
    scope: string;
    generation: number;
    service?: typeof service;
    agentService?: typeof lcodeAgentService;
    worktreeService?: typeof worktreeService;
    projectExecutionSetService?: typeof projectExecutionSetService;
    workspace?: LCodeWorkspaceRef;
    binding?: WorktreeBinding;
    error?: string;
  }>({ scope, generation });
  useEffect(() => {
    if (!taskId || !resolution.rpcReady) return;
    let cancelled = false;
    let attempt = 0;
    let readyKey: string | null = null;
    const owner = {
      scope,
      generation,
      service,
      agentService: lcodeAgentService,
      worktreeService,
      projectExecutionSetService,
    };
    const connection = acquireWorkspaceConnection(
      {
        workspacePath,
        workspaceIdentity,
        ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
      },
      lcodeAgentService,
    );
    connection.activateRemoteService();
    const session = connection.layer.acquire(taskId);
    setState(owner);
    const observe = () => {
      const projection = session.store.getState();
      if (projection.status !== "live" || projection.syncing || !projection.snapshot) {
        // 冷会话 readSession 只读活跃 runtime；先复用聊天的恢复/就绪闸门，不能抢读后永久停在错误。
        if (readyKey !== null) {
          readyKey = null;
          attempt++;
          setState(owner);
        }
        if (projection.status === "error")
          setState({ ...owner, error: projection.lastError ?? "会话连接失败，请重试。" });
        return;
      }
      const nextReadyKey = JSON.stringify([
        projection.subscriptionId,
        projection.snapshot.logEpoch,
      ]);
      if (nextReadyKey === readyKey) return;
      readyKey = nextReadyKey;
      const currentAttempt = ++attempt;
      setState(owner);
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
        if (cancelled || currentAttempt !== attempt) return;
        if (snapshot.status === "rejected") throw snapshot.reason;
        const workspace = snapshot.value.session.workspace;
        if (workspace.executionSetRef) {
          if (!projectExecutionSetService)
            throw new Error("Collaboration execution set owner is unavailable");
          const reference = workspace.executionSetRef;
          const target = { ...reference.origin, executionSetId: reference.executionSetId };
          const [set, repositories] = await Promise.all([
            projectExecutionSetService.get(target),
            projectExecutionSetService.bindings(target),
          ]);
          if (
            set?.status !== "ready" ||
            reference.bindings.some(
              (expected) =>
                !repositories.some(
                  (view) =>
                    view.binding?.id === expected.bindingId &&
                    view.binding.status === "ready" &&
                    !view.error &&
                    (view.binding.workspaceIdentity?.trim() || view.binding.workspacePath) ===
                      (expected.workspaceIdentity?.trim() || expected.workspacePath),
                ),
            )
          )
            throw new Error(set?.error || "Collaboration repositories are not all ready");
          if (cancelled || currentAttempt !== attempt) return;
        }
        if (
          workspace.executionBindingId &&
          (binding.status === "rejected" || !binding.value || binding.value.status !== "ready")
        )
          throw new Error("工作树尚未就绪，请在会话中恢复或检查实际执行目录。");
        setState({
          ...owner,
          workspace,
          ...(binding.status === "fulfilled" && binding.value ? { binding: binding.value } : {}),
        });
      })().catch((error: unknown) => {
        // 会话、Host、恢复代次或生命周期变化后，迟到的成功和失败都没有回写当前目录的权限。
        if (!cancelled && currentAttempt === attempt)
          setState({ ...owner, error: error instanceof Error ? error.message : String(error) });
      });
    };
    const unsubscribe = session.store.subscribe(observe);
    if (retryRevision > 0 && session.store.getState().status === "error")
      void session.store.retry();
    observe();
    return () => {
      cancelled = true;
      unsubscribe();
      session.release();
      connection.release();
    };
  }, [
    service,
    lcodeAgentService,
    worktreeService,
    projectExecutionSetService,
    workspacePath,
    workspaceIdentity,
    taskId,
    resolution.remoteSessionId,
    resolution.rpcReady,
    scope,
    generation,
    retryRevision,
  ]);
  if (!taskId)
    return {
      workspace: {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      } as LCodeWorkspaceRef,
      binding: undefined,
      pending: false,
      retry,
    };
  // 相同路径的远端 attachment / service 换代也属于 owner 切换，旧结果不能短暂冒充新目录。
  return state.scope === scope &&
    state.generation === generation &&
    resolution.rpcReady &&
    state.service === service &&
    state.agentService === lcodeAgentService &&
    state.worktreeService === worktreeService &&
    state.projectExecutionSetService === projectExecutionSetService
    ? { ...state, pending: !state.workspace && !state.error, retry }
    : { workspace: undefined, binding: undefined, pending: true, retry };
}
