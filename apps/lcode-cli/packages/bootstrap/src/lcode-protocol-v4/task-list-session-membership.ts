import type { SessionTaskType } from "@lcode/contracts";

/**
 * 左侧任务列表的 session 类型投影。
 *
 * 列表可见性不能用 `parent_id is null` 的层级查询代替：显式 fork
 * 这类有 parent 的主任务会在 CLI 重启后被冷启动种子过滤。可见性必须由 taskType 决定，
 * 而辅助对话、subagent 与 workflow child 继续由各自专用投影承载。
 */
export const TASK_LIST_SESSION_TYPES = [
  "interactive",
  "fork",
  "workflow_parent",
] as const satisfies readonly SessionTaskType[];

const TASK_LIST_SESSION_TYPE_SET = new Set<SessionTaskType>(
  TASK_LIST_SESSION_TYPES,
);

export function isTaskListSessionType(
  taskType: SessionTaskType | undefined,
): boolean {
  return TASK_LIST_SESSION_TYPE_SET.has(taskType ?? "interactive");
}
