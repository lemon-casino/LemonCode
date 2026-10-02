import type { WorkflowRunNode } from "@lcode/shared/lcode-protocol-v4";

interface LaneNodes {
  nodes: WorkflowRunNode[];
  byOrdinal: Map<number | undefined, WorkflowRunNode[]>;
}

export interface WorkflowRunNodeIndex {
  bySite: ReadonlyMap<string, readonly WorkflowRunNode[]>;
  forLane(siteId: string, lane: string): readonly WorkflowRunNode[];
  forActor(siteId: string, lane: string, ordinal: number | undefined): readonly WorkflowRunNode[];
  inProjectionOrder(candidates: readonly WorkflowRunNode[]): readonly WorkflowRunNode[];
  deliveredAt(node: WorkflowRunNode | undefined): number | undefined;
}

const EMPTY_NODES: readonly WorkflowRunNode[] = [];
const indexes = new WeakMap<readonly WorkflowRunNode[], WorkflowRunNodeIndex>();

function acceptedDelivery(node: WorkflowRunNode): number | undefined {
  const at = node.settledAt;
  return node.phase === "settled" &&
    node.outcome === "ok" &&
    node.cached !== true &&
    at !== undefined &&
    Number.isSafeInteger(at) &&
    at >= 0 &&
    at <= 8.64e15
    ? at
    : undefined;
}

/**
 * 同站点 256 个实例曾在每枚药丸里重扫节点窗口，状态/活动/最近交付合计退化为 O(actor × node)。
 * 只为当前不可变 nodes[] 建一次索引；新 wire/snapshot 数组重新派生，旧数组可被回收。
 * 索引不保存窗口外历史，也不缓存 run 终态或 syncing/stale；所有复合身份用嵌套 Map，不拼字符串。
 */
export function workflowRunNodeIndex(
  nodes: readonly WorkflowRunNode[] = EMPTY_NODES,
): WorkflowRunNodeIndex {
  const cached = indexes.get(nodes);
  if (cached !== undefined) return cached;
  const bySite = new Map<string, WorkflowRunNode[]>();
  const bySiteLane = new Map<string, Map<string, LaneNodes>>();
  const byInstance = new Map<string, Map<number, WorkflowRunNode>>();
  const order = new Map<WorkflowRunNode, number>();
  const deliveries = new Map<WorkflowRunNode, number>();
  const actorDelivery = new Map<string, Map<number, number>>();

  for (const [position, node] of nodes.entries()) {
    const { siteId, ordinal, actorSiteId, actorOrdinal } = node;
    let siteNodes = bySite.get(siteId);
    if (siteNodes === undefined) bySite.set(siteId, (siteNodes = []));
    siteNodes.push(node);
    let instances = byInstance.get(siteId);
    if (instances === undefined) byInstance.set(siteId, (instances = new Map()));
    instances.set(ordinal, node);
    order.set(node, position);

    if (actorSiteId !== undefined) {
      let lanes = bySiteLane.get(siteId);
      if (lanes === undefined) bySiteLane.set(siteId, (lanes = new Map()));
      let lane = lanes.get(actorSiteId);
      if (lane === undefined) {
        lane = { nodes: [], byOrdinal: new Map() };
        lanes.set(actorSiteId, lane);
      }
      lane.nodes.push(node);
      let actorNodes = lane.byOrdinal.get(actorOrdinal);
      if (actorNodes === undefined) lane.byOrdinal.set(actorOrdinal, (actorNodes = []));
      actorNodes.push(node);
    }

    let deliveredAt = acceptedDelivery(node);
    if (actorSiteId !== undefined && actorOrdinal !== undefined) {
      let byOrdinal = actorDelivery.get(actorSiteId);
      if (byOrdinal === undefined) actorDelivery.set(actorSiteId, (byOrdinal = new Map()));
      const previous = byOrdinal.get(actorOrdinal);
      if (previous !== undefined)
        deliveredAt = deliveredAt === undefined ? previous : Math.max(previous, deliveredAt);
      if (deliveredAt !== undefined) byOrdinal.set(actorOrdinal, deliveredAt);
    }
    // 前缀在当前节点的位置封口：较晚阶段的交付不能倒灌，缺 actor 身份只认节点自己的交付。
    if (deliveredAt !== undefined) deliveries.set(node, deliveredAt);
  }

  const index: WorkflowRunNodeIndex = {
    bySite,
    forLane: (siteId, lane) => bySiteLane.get(siteId)?.get(lane)?.nodes ?? EMPTY_NODES,
    forActor: (siteId, lane, ordinal) =>
      bySiteLane.get(siteId)?.get(lane)?.byOrdinal.get(ordinal) ?? EMPTY_NODES,
    inProjectionOrder: (candidates) => {
      const selected = new Set<WorkflowRunNode>();
      for (const candidate of candidates) {
        // 调用方可按多个 site 收集，或传等值副本；事实与 FIFO 均以父投影的节点和原序为准。
        const node = order.has(candidate)
          ? candidate
          : byInstance.get(candidate.siteId)?.get(candidate.ordinal);
        if (node !== undefined) selected.add(node);
      }
      return [...selected].sort((left, right) => order.get(left)! - order.get(right)!);
    },
    deliveredAt: (node) => (node === undefined ? undefined : deliveries.get(node)),
  };
  indexes.set(nodes, index);
  return index;
}
