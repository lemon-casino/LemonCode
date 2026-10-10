import type { LCodeTaskMeta } from "@lcode/shared";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useGitFailureHandoff } from "@/hooks/useGitFailureHandoff.js";

/** Reuses the existing focused Composer receiver; the menu never owns accepted input. */
export function useTaskHandoff(task: LCodeTaskMeta) {
  const targetId = useLCodeSessionStore(
    (state) => state.getWorkspaceState(task.workspacePath, task.workspaceIdentity).activeTaskId,
  );
  const receiver = useGitFailureHandoff(
    task.workspacePath,
    task.workspaceIdentity,
    targetId ?? undefined,
  );
  return {
    available: Boolean(targetId && targetId !== task.taskId && receiver.available),
    insert(text: string) {
      const current = useLCodeSessionStore
        .getState()
        .getWorkspaceState(task.workspacePath, task.workspaceIdentity).activeTaskId;
      // 菜单打开后可能切换会话；必须复核目标，不能把旧意图写入新的 Composer。
      if (!targetId || current !== targetId || targetId === task.taskId) return false;
      return receiver.transfer(text);
    },
  };
}
