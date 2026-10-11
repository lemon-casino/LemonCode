import { useCallback } from "react";
import type { WorktreeBinding } from "@lcode/services";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { isWorktreeSidebarWorkspace } from "@/lib/worktreeSidebar.js";

export function useWorktreeDeletionProjection() {
  const tabs = useTabStoreApi();
  return useCallback(
    (binding: WorktreeBinding) => {
      // 管理页接收 owner 的精确删除事实后才清理索引，不影响同路径的另一远端身份。
      for (const scope of [
        {
          workspacePath: binding.originalWorkspacePath,
          workspaceIdentity: binding.originalWorkspaceIdentity,
        },
        { workspacePath: binding.workspacePath, workspaceIdentity: binding.workspaceIdentity },
      ]) {
        for (const taskId of binding.deletion?.sessionIds ?? [binding.taskId])
          removeTaskFromTaskCaches({ ...scope, taskId });
        useLCodeSessionStore
          .getState()
          .bumpTaskListVersion(scope.workspacePath, scope.workspaceIdentity);
      }
      for (const tab of tabs.getState().tabs)
        if (tab.kind === "workspace" && isWorktreeSidebarWorkspace(tab, [binding]))
          tabs.getState().closeTab(tab.id);
    },
    [tabs],
  );
}
