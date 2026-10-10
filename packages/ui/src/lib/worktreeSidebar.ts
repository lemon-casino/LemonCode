import type { WorktreeBinding, LCodeGroupedTaskView } from "@lcode/services";
import type { LCodeTaskMeta } from "@lcode/shared";

type WorkspaceScope = { workspacePath: string; workspaceIdentity?: string };
const scopeKey = (scope: WorkspaceScope) => scope.workspaceIdentity?.trim() || scope.workspacePath;

export function isWorktreeSidebarWorkspace(
  scope: WorkspaceScope,
  bindings: readonly WorktreeBinding[],
) {
  return bindings.some(
    (binding) =>
      (scope.workspacePath === binding.workspacePath ||
        scope.workspacePath === binding.checkoutPath) &&
      (scope.workspaceIdentity?.trim() || binding.workspaceIdentity?.trim()
        ? scopeKey(scope) === scopeKey(binding)
        : true),
  );
}

export function isTaskInSidebarBinding(task: LCodeTaskMeta, binding: WorktreeBinding) {
  const origin = {
    workspacePath: binding.originalWorkspacePath,
    workspaceIdentity: binding.originalWorkspaceIdentity,
  };
  // 同路径远端必须同时匹配身份；bindingId 只在对应原项目/执行范围内使用。
  const inScope =
    scopeKey(task) === scopeKey(origin) || isWorktreeSidebarWorkspace(task, [binding]);
  return (
    inScope &&
    (task.executionBindingId?.trim()
      ? task.executionBindingId === binding.id
      : task.taskId === binding.taskId || isWorktreeSidebarWorkspace(task, [binding]))
  );
}

export function isWorktreeSidebarTask(task: LCodeTaskMeta, bindings: readonly WorktreeBinding[]) {
  return (
    Boolean(task.executionBindingId?.trim()) ||
    bindings.some((binding) => isTaskInSidebarBinding(task, binding))
  );
}

/**
 * 创建路径的失效广播签名：同一 scope 下同一 binding 的同一状态只广播一次。
 *
 * 准备轮询每 750ms 读一次 binding，直接按读取结果广播会把轮询放大成侧栏刷新风暴；
 * 只在首次观察到 binding 或状态迁移时换出新签名，调用方据此决定是否广播。
 */
export function worktreeBindingAnnouncementSignature(
  scope: string,
  binding: { id: string; status: string } | null | undefined,
): string | null {
  return binding ? JSON.stringify([scope, binding.id, binding.status]) : null;
}

/** 仅过滤展示副本：分组拖拽和持久成员继续使用完整 owner 投影，防止隐藏成员被写丢。 */
export function filterOrdinaryGroupedView(
  view: LCodeGroupedTaskView,
  bindings: readonly WorktreeBinding[],
): LCodeGroupedTaskView {
  return {
    ...view,
    nodes: view.nodes.flatMap<LCodeGroupedTaskView["nodes"][number]>((node) =>
      node.type === "task"
        ? isWorktreeSidebarTask(node.task, bindings)
          ? []
          : [node]
        : [{ ...node, tasks: node.tasks.filter((task) => !isWorktreeSidebarTask(task, bindings)) }],
    ),
  };
}
