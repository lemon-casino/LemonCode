// 会话事件 → workflowRuns 镜像的桥（app-events.ts 的 dwf case 只调这一个函数）。
//
// 单独成模块的理由有两个：把 contracts 的载荷类型收在这里，让 app-workflow-mirror.ts
// 保持「只依赖 @lcode/shared」的纪律（与共享 reducer 不得反向依赖 contracts 同一姿态）；
// 顺带让 app-events.ts 的 switch 保持在 max-lines 之内。
import type { DynamicWorkflowRunProgressPayload } from "@lcode/contracts";
import type { WorkflowRunProgressEnvelope } from "@lcode/shared/lcode-protocol-v4";
import { applyWorkflowProgressToMirror, type TuiWorkflowMirror } from "./app-workflow-mirror.js";

export type WorkflowMirrorSetter = (
  updater: (current: TuiWorkflowMirror) => TuiWorkflowMirror,
) => void;

/**
 * 把一条 `dynamic_workflow_run_progress` 事件归约进镜像。
 *
 * 投影侧的对应物是 bootstrap 的 `onDynamicWorkflowRunProgress`——两边调**同一个**共享 reducer，
 * 所以 TUI 与桌面不可能对同一串事件算出不同状态。
 */
export function applyWorkflowProgressEvent(
  payload: unknown,
  setWorkflowMirror?: WorkflowMirrorSetter,
): void {
  if (!setWorkflowMirror) return;
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值是「两边形状不漂移」
  // 的编译期闸（与 bootstrap 的 v4 投影同一姿态）。
  const envelope: WorkflowRunProgressEnvelope = payload as DynamicWorkflowRunProgressPayload;
  // 无变化时 applyWorkflowProgressToMirror 回传同一个引用，React 因此直接跳过重渲染：
  // 共享 reducer 的「null = 语义无变化」在 UI 侧就是「不重绘」。
  setWorkflowMirror((current) => applyWorkflowProgressToMirror(current, envelope));
}
