// 工作流事实信封桥接；继续复用 shared 的唯一 workflow reducer。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { SessionEvent, DynamicWorkflowRunProgressPayload } from "@lcode/contracts";
import {
  type ConversationDelta,
  type WorkflowRunProgressEnvelope,
  reduceWorkflowRunsState,
} from "@lcode/shared/lcode-protocol-v4";

import { trackWorkflowProjectionBytes } from "./conversation-topic-workflow-bytes.js";

type DynamicWorkflowRunProgressHost = Pick<ProductProjectionState, "snapshot">;

// ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
// 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
// 所以持久、可回放、冷恢复免费（先例：subagents 键）。
//
// 归约本体在 @lcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
// 同一份归约，两处各写一份就是两个时钟。
// 留在这里的只有投影的非纯部分——从事件信封取载荷、把新状态发成 state.updated。
export function onDynamicWorkflowRunProgress(
  host: DynamicWorkflowRunProgressHost,
  event: SessionEvent,
): ConversationDelta[] {
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
  // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
  const envelope: WorkflowRunProgressEnvelope = event.payload as DynamicWorkflowRunProgressPayload;
  const workflowRuns = reduceWorkflowRunsState(host.snapshot.workflowRuns, envelope);
  // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
  if (workflowRuns === null) return [];
  trackWorkflowProjectionBytes(workflowRuns, host.snapshot.workflowRuns);
  return [{ op: "state.updated", patch: { workflowRuns } }];
}
