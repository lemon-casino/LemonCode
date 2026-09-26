export type TasksStorageStartupFailure =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown };

export const NO_TASKS_STORAGE_STARTUP_FAILURE: TasksStorageStartupFailure = Object.freeze({
  failed: false,
});

/** 关闭全部已打开资源；主体失败始终优先，不能被后续清理异常覆盖。 */
export function closeTasksStorageStartupResources(
  primaryFailure: TasksStorageStartupFailure,
  closeResources: readonly (() => void)[],
): void {
  let closeFailure: TasksStorageStartupFailure = NO_TASKS_STORAGE_STARTUP_FAILURE;
  for (const closeResource of closeResources) {
    try {
      closeResource();
    } catch (error) {
      if (!closeFailure.failed) closeFailure = { failed: true, error };
    }
  }
  if (primaryFailure.failed) throw primaryFailure.error;
  if (closeFailure.failed) throw closeFailure.error;
}
