import type { ILCodeTaskService } from "@lcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { logger } from "@/logger.js";
import type { LCodeTaskMeta } from "@lcode/shared";

export interface ArchivedTaskDeletionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export interface ArchivedTaskDeletionWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  service?: Pick<ILCodeTaskService, "deleteArchivedTasks">;
}

export interface ArchivedTaskDeletionSelection {
  groups: Array<{
    workspace: ArchivedTaskDeletionWorkspace;
    targets: ArchivedTaskDeletionTarget[];
  }>;
  count: number;
  unavailableWorkspaces: string[];
}

/**
 * 选择集直接取自归档列表当前分类已渲染的行（Host Controller 投影行）。
 *
 * 根因：tasks-index 原始行不持久化 executionBindingId，工作树归属只由 sessions-index 覆盖层下发。
 * 过去按原始行重新查询并套一遍分类谓词，会把工作树会话全部滤掉，出现“列表看得见、一键删除却收集到 0 项”。
 * 这里不再重新查询、也不再自行分类，避免产生第二条分类真值。见 specs/archived-task-deletion.md。
 */
export function collectArchivedTaskDeletion(
  workspaces: ArchivedTaskDeletionWorkspace[],
  visibleTasks: readonly LCodeTaskMeta[],
): ArchivedTaskDeletionSelection {
  const workspaceByKey = new Map(
    workspaces.map((workspace) => [
      buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
      workspace,
    ]),
  );
  const targetsByWorkspaceKey = new Map<string, ArchivedTaskDeletionTarget[]>();
  for (const task of visibleTasks) {
    const key = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    // 可见行可能属于本次没有 service 的 scope；不在传入集合内就不纳入。
    if (!workspaceByKey.has(key)) continue;
    const targets = targetsByWorkspaceKey.get(key) ?? [];
    if (!targets.some((target) => target.taskId === task.taskId)) {
      targets.push({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        workspaceIdentity: task.workspaceIdentity,
      });
    }
    targetsByWorkspaceKey.set(key, targets);
  }

  const groups: ArchivedTaskDeletionSelection["groups"] = [];
  const unavailableWorkspaces: string[] = [];
  for (const [key, targets] of targetsByWorkspaceKey) {
    const workspace = workspaceByKey.get(key);
    if (!workspace) continue;
    // 远端 source 未连接时不能发删除请求，也不能退回本机 sqlite；只把该项目记为不可用。
    if (!workspace.service) {
      unavailableWorkspaces.push(workspace.label);
      continue;
    }
    groups.push({ workspace, targets });
  }

  return {
    groups,
    count: groups.reduce((count, group) => count + group.targets.length, 0),
    unavailableWorkspaces,
  };
}

export async function deleteArchivedTaskSelection(
  selection: ArchivedTaskDeletionSelection,
  onDeleted: (target: ArchivedTaskDeletionTarget) => void,
) {
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  // 同一 workspace 一次 RPC，让原 source 在逐项事务后统一发事件；独立 source 可以并行。
  await Promise.all(
    selection.groups.map(async ({ workspace, targets }) => {
      if (targets.length === 0) return;
      let result: Awaited<ReturnType<ILCodeTaskService["deleteArchivedTasks"]>>;
      try {
        result = await workspace.service!.deleteArchivedTasks({
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          taskIds: targets.map((target) => target.taskId),
        });
      } catch (error) {
        failed += targets.length;
        logger.warn("[ArchivedTaskDeletion] 工作区批次删除失败", {
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          error,
        });
        return;
      }
      const deletedIds = new Set(result.deletedTaskIds);
      const skippedIds = new Set(result.skippedTaskIds);
      for (const target of targets) {
        if (deletedIds.has(target.taskId)) {
          deleted += 1;
          onDeleted(target);
        } else if (skippedIds.has(target.taskId)) {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
    }),
  );
  return { deleted, skipped, failed, unavailableWorkspaces: selection.unavailableWorkspaces };
}
