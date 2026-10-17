import { useEffect, useState } from "react";
import type { LCodeTaskMeta } from "@lcode/shared";
import type { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";

/** 树行和会话菜单共用所属 Host 的门禁；UI 不推断 Git 能力或重建绑定事实。 */
export function useTaskForkAvailability(
  task: Pick<
    LCodeTaskMeta,
    "workspacePath" | "workspaceIdentity" | "executionBindingId" | "executionSetRef"
  > & { taskId?: string },
  resolved: ReturnType<typeof useWorkspaceServicesResolution>,
  enabled: boolean,
) {
  const { workspacePath, workspaceIdentity, taskId, executionBindingId, executionSetRef } = task;
  const { services, rpcReady } = resolved;
  const revision = useWorktreeLifecycleStore((state) =>
    enabled ? (state.revisions[workspaceIdentity?.trim() || workspacePath] ?? 0) : 0,
  );
  const scope = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    workspacePath,
    taskId,
    executionBindingId,
    executionSetRef,
    revision,
  ]);
  const [state, setState] = useState<{
    scope: string;
    services: typeof services;
    same: boolean;
    worktree: boolean;
    reason?: string;
  }>();
  useEffect(() => {
    let active = true;
    setState(undefined);
    if (!enabled || !rpcReady || !services.worktreeService || !taskId) return;
    const target = { workspacePath, workspaceIdentity };
    if (executionSetRef) {
      const owner = services.projectExecutionSetService;
      if (owner)
        void owner
          .get({ ...executionSetRef.origin, executionSetId: executionSetRef.executionSetId })
          .then(
            (snapshot) => {
              if (active)
                setState({
                  scope,
                  services,
                  same: snapshot?.status === "ready",
                  worktree: snapshot?.status === "ready",
                  reason: snapshot?.error,
                });
            },
            (error) => {
              if (active)
                setState({
                  scope,
                  services,
                  same: false,
                  worktree: false,
                  reason: getErrorMessage(error),
                });
            },
          );
      return () => {
        active = false;
      };
    }
    // 能力与绑定可并行读取；归档树的原项目依旧是 Git 仓库，单看 create 会错误放行。
    void Promise.allSettled([
      services.worktreeService.getCapabilities(target),
      executionBindingId
        ? services.worktreeService.getBinding({ ...target, taskId })
        : Promise.resolve(null),
    ]).then(([capabilities, binding]) => {
      if (!active) return;
      const same =
        !executionBindingId ||
        (binding.status === "fulfilled" &&
          binding.value?.id === executionBindingId &&
          binding.value.status === "ready");
      setState({
        scope,
        services,
        same,
        worktree: same && capabilities.status === "fulfilled" && capabilities.value.create,
        reason:
          capabilities.status === "fulfilled"
            ? capabilities.value.reason
            : getErrorMessage(capabilities.reason),
      });
    });
    return () => {
      active = false;
    };
  }, [
    enabled,
    rpcReady,
    services,
    scope,
    workspacePath,
    workspaceIdentity,
    taskId,
    executionBindingId,
    executionSetRef,
  ]);
  // 切换 scope/连接后，旧请求即使成功也不能短暂启用新目标的菜单。
  const current =
    enabled && rpcReady && state?.scope === scope && state.services === services
      ? state
      : undefined;
  return {
    same:
      Boolean(taskId) &&
      enabled &&
      rpcReady &&
      (!(executionBindingId || executionSetRef) || (current?.same ?? false)),
    worktree: current?.worktree ?? false,
    reason: current?.reason,
  };
}
