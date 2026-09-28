import {
  WorkflowGraphPlannerResultSchema,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowGraphPlannerNode,
  type WorkflowRunSnapshot,
} from "@lcode/contracts";
import {
  collectionFrontier,
  collectionNodeIdsForGraph,
  edgeId,
  graphCollections,
  normalizeCollection,
} from "./graph.js";
import type {
  AppliedPlannerExpansion,
  SchedulerCollection,
  WorkflowGraphRecordEdge,
  WorkflowGraphSchedulerPlannerRunResult,
} from "./types.js";

export function applyPlannerExpansion(
  snapshot: WorkflowRunSnapshot,
  collection: SchedulerCollection,
  rawResult: WorkflowGraphSchedulerPlannerRunResult,
  unseenCompletions: readonly string[],
  timestamp: string,
): AppliedPlannerExpansion {
  const result = WorkflowGraphPlannerResultSchema.parse(rawResult);
  const existingNodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  const addedNodes = (result.nodes ?? []).map((node) =>
    workflowNodeFromPlannerNode(node, collection.collectionId),
  );
  for (const node of addedNodes) {
    if (existingNodeIds.has(node.id)) {
      throw new Error(`Planner returned duplicate workflow node: ${node.id}`);
    }
    existingNodeIds.add(node.id);
  }

  const addedEdges = normalizePlannerEdges(snapshot.graph, addedNodes, result.edges ?? []);
  validateNewEdges(snapshot.graph, addedNodes, addedEdges);

  const existingCollectionNodeIds = collectionNodeIdsForGraph(collection, snapshot.graph);
  const collectionNodeIds = [
    ...new Set([
      ...existingCollectionNodeIds,
      ...(result.collectionNodeIds ?? addedNodes.map((node) => node.id)),
    ]),
  ];
  const graphChanged = addedNodes.length > 0 || addedEdges.length > 0;
  const nextStatus =
    result.exhausted === true
      ? "exhausted"
      : !graphChanged &&
          collectionFrontier(snapshot.graph, collection) === 0 &&
          unseenCompletions.length === 0
        ? collection.status === "draining"
          ? "exhausted"
          : "draining"
        : "active";
  const nextCollection = normalizeCollection({
    ...collection,
    analyzedNodeIds: [...new Set([...collection.analyzedNodeIds, ...unseenCompletions])],
    exhausted: nextStatus === "exhausted",
    lastGraphChangeAt: graphChanged ? timestamp : collection.lastGraphChangeAt,
    nodeIds: collectionNodeIds,
    status: nextStatus,
  });

  return {
    addedEdges,
    addedNodes,
    collection: nextCollection,
    snapshot: {
      ...snapshot,
      graph: {
        collections: graphCollections(snapshot.graph).map((item) =>
          item.collectionId === collection.collectionId ? nextCollection : item,
        ),
        edges: [...snapshot.graph.edges, ...addedEdges],
        nodes: [...snapshot.graph.nodes, ...addedNodes],
      },
      updatedAt: timestamp,
    },
  };
}

function workflowNodeFromPlannerNode(
  node: WorkflowGraphPlannerNode,
  fallbackCollectionId: string,
): WorkflowGraphNode {
  return {
    collectionId: node.collectionId ?? fallbackCollectionId,
    dependsOn: node.dependsOn ?? [],
    description: node.description,
    id: node.id,
    kind: node.kind ?? "task",
    phase: node.phase,
    prompt: node.prompt,
    status: "pending",
    title: node.title,
  };
}

function normalizePlannerEdges(
  graph: WorkflowGraph,
  addedNodes: readonly WorkflowGraphNode[],
  plannerEdges: readonly WorkflowGraphRecordEdge[],
): WorkflowGraphRecordEdge[] {
  const edges = [...plannerEdges];
  const existing = new Set([...graph.edges, ...edges].map(edgeId));
  for (const node of addedNodes) {
    for (const dependencyId of node.dependsOn) {
      const edge = { from: dependencyId, to: node.id };
      if (existing.has(edgeId(edge))) continue;
      edges.push(edge);
      existing.add(edgeId(edge));
    }
  }
  return edges;
}

function validateNewEdges(
  graph: WorkflowGraph,
  addedNodes: readonly WorkflowGraphNode[],
  addedEdges: readonly WorkflowGraphRecordEdge[],
): void {
  const nodeIds = new Set([
    ...graph.nodes.map((node) => node.id),
    ...addedNodes.map((node) => node.id),
  ]);
  const existingEdgeIds = new Set(graph.edges.map(edgeId));
  const pendingEdges = [...graph.edges];
  for (const edge of addedEdges) {
    if (edge.from === edge.to) {
      throw new Error(`Planner returned a self-loop edge: ${edge.from} -> ${edge.to}`);
    }
    if (!nodeIds.has(edge.from)) {
      throw new Error(`Planner returned an edge with unknown source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Planner returned an edge with unknown target node: ${edge.to}`);
    }
    const id = edgeId(edge);
    if (existingEdgeIds.has(id)) {
      throw new Error(`Planner returned duplicate workflow edge: ${id}`);
    }
    if (wouldFormCycle(pendingEdges, edge)) {
      throw new Error(`Planner returned an edge that would create a cycle: ${id}`);
    }
    existingEdgeIds.add(id);
    pendingEdges.push(edge);
  }
}

function wouldFormCycle(
  edges: readonly WorkflowGraphRecordEdge[],
  newEdge: WorkflowGraphRecordEdge,
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const visited = new Set<string>();
  const queue: string[] = [newEdge.to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newEdge.from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return false;
}
