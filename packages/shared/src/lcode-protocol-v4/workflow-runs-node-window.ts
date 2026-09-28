import type { WorkflowRunNode } from "./workflow-runs.js";

/** 有界运行态节点窗口：先更新已知实例，满额时以最早结束的节点让出位置给新活动节点。 */
export function upsertBoundedRunNode(
  nodes: readonly WorkflowRunNode[],
  incoming: WorkflowRunNode,
  limit: number,
): { list: WorkflowRunNode[]; truncated: boolean } {
  const existing = nodes.findIndex(
    (node) => node.siteId === incoming.siteId && node.ordinal === incoming.ordinal,
  );
  if (existing >= 0) {
    const list = [...nodes];
    list[existing] = incoming;
    return { list, truncated: false };
  }
  if (nodes.length < limit) return { list: [...nodes, incoming], truncated: false };
  const finished = nodes.findIndex((node) => node.phase === "settled");
  // 无可回收槽位时保留现有活动实例；截断标志提醒读者不能据此推断全部节点。
  if (finished < 0) return { list: [...nodes], truncated: true };
  return {
    list: [...nodes.slice(0, finished), ...nodes.slice(finished + 1), incoming],
    truncated: true,
  };
}
