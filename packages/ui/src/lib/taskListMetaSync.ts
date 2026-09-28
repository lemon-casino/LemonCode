import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { removeTaskFromTaskQueryCaches } from "@/store/taskQueryCacheStore.js";

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useLCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}
