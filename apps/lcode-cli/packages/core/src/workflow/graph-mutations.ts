import {
  WorkflowGraphSeedSchema,
  WorkflowNodePromptUpdateSetSchema,
  type WorkflowGraphCollection,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowGraphSeed,
  type WorkflowNodePromptUpdate,
  type WorkflowRunSnapshot,
} from "@lcode/contracts";

export interface ApplyWorkflowGraphSeedOptions {
  phase?: string;
  timestamp: string;
}

export interface ApplyWorkflowGraphSeedResult<TSnapshot extends WorkflowRunSnapshot> {
  addedCollections: WorkflowGraphCollection[];
  addedEdges: WorkflowGraphEdge[];
  addedNodes: WorkflowGraphNode[];
  changed: boolean;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowNodePromptUpdatesOptions {
  phase: string;
  timestamp: string;
}

export interface ApplyWorkflowNodePromptUpdatesResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  snapshot: TSnapshot;
  updatedNodes: WorkflowGraphNode[];
}

export function applyWorkflowGraphSeed<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  seed: WorkflowGraphSeed,
  options: ApplyWorkflowGraphSeedOptions,
): ApplyWorkflowGraphSeedResult<TSnapshot> {
  const parsedSeed = WorkflowGraphSeedSchema.parse(seed);
  const existingNodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  const addedNodes: WorkflowGraphNode[] = [];
  const pendingNodeIds = new Set<string>();

  for (const node of parsedSeed.nodes) {
    if (existingNodeIds.has(node.id) || pendingNodeIds.has(node.id)) {
      throw new Error(`Workflow graph seed returned duplicate node: ${node.id}`);
    }
    pendingNodeIds.add(node.id);
    addedNodes.push({
      collectionId: node.collectionId,
      dependsOn: uniqueStrings(node.dependsOn ?? []),
      description: node.description,
      id: node.id,
      kind: node.kind ?? "task",
      phase: node.phase ?? options.phase,
      prompt: node.prompt,
      status: "pending",
      title: node.title,
    });
  }

  const addedEdges = normalizeSeedEdges(snapshot.graph.edges, addedNodes, parsedSeed.edges);
  validateAddedEdges(snapshot.graph.nodes, snapshot.graph.edges, addedNodes, addedEdges);

  const knownNodeIds = new Set([
    ...snapshot.graph.nodes.map((node) => node.id),
    ...addedNodes.map((node) => node.id),
  ]);
  const existingCollectionIds = new Set(
    (snapshot.graph.collections ?? []).map((collection) => collection.collectionId),
  );
  const addedCollections: WorkflowGraphCollection[] = [];
  const pendingCollectionIds = new Set<string>();
  for (const collection of parsedSeed.collections) {
    if (
      existingCollectionIds.has(collection.collectionId) ||
      pendingCollectionIds.has(collection.collectionId)
    ) {
      throw new Error(
        `Workflow graph seed returned duplicate collection: ${collection.collectionId}`,
      );
    }
    pendingCollectionIds.add(collection.collectionId);
    const implicitNodeIds = addedNodes
      .filter((node) => node.collectionId === collection.collectionId)
      .map((node) => node.id);
    const nodeIds = uniqueStrings([...(collection.nodeIds ?? []), ...implicitNodeIds]);
    for (const nodeId of nodeIds) {
      if (!knownNodeIds.has(nodeId)) {
        throw new Error(
          `Workflow graph seed collection "${collection.collectionId}" references unknown node: ${nodeId}`,
        );
      }
    }
    addedCollections.push({
      collectionId: collection.collectionId,
      explorable: collection.explorable,
      frontierTarget: collection.frontierTarget,
      goal: collection.goal,
      metric: collection.metric,
      nodeIds,
      phase: collection.phase ?? options.phase,
      title: collection.title,
    });
  }

  const changed = addedNodes.length > 0 || addedEdges.length > 0 || addedCollections.length > 0;
  return {
    addedCollections,
    addedEdges,
    addedNodes,
    changed,
    snapshot: changed
      ? ({
          ...snapshot,
          graph: {
            collections: [...(snapshot.graph.collections ?? []), ...addedCollections],
            edges: [...snapshot.graph.edges, ...addedEdges],
            nodes: [...snapshot.graph.nodes, ...addedNodes],
          },
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function applyWorkflowNodePromptUpdates<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  updates: readonly WorkflowNodePromptUpdate[],
  options: ApplyWorkflowNodePromptUpdatesOptions,
): ApplyWorkflowNodePromptUpdatesResult<TSnapshot> {
  const parsedUpdates = WorkflowNodePromptUpdateSetSchema.parse({ nodes: updates }).nodes;
  const updatesByNodeId = new Map<string, WorkflowNodePromptUpdate>();
  for (const update of parsedUpdates) {
    if (updatesByNodeId.has(update.id)) {
      throw new Error(`Workflow node prompt update returned duplicate node: ${update.id}`);
    }
    updatesByNodeId.set(update.id, update);
  }
  if (updatesByNodeId.size === 0) {
    return { changed: false, snapshot, updatedNodes: [] };
  }

  const nodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  for (const nodeId of updatesByNodeId.keys()) {
    if (!nodeIds.has(nodeId)) {
      throw new Error(`Workflow node prompt update references unknown node: ${nodeId}`);
    }
  }

  const updatedNodes: WorkflowGraphNode[] = [];
  const nodes = snapshot.graph.nodes.map((node) => {
    const update = updatesByNodeId.get(node.id);
    if (!update) return node;
    if (node.phase !== undefined && node.phase !== options.phase) {
      throw new Error(
        `Workflow node prompt update for "${node.id}" targets phase "${options.phase}" but node belongs to "${node.phase}"`,
      );
    }

    const nextNode: WorkflowGraphNode = {
      ...node,
      description: update.description ?? node.description,
      prompt: update.prompt ?? node.prompt,
      title: update.title ?? node.title,
    };
    if (
      nextNode.description === node.description &&
      nextNode.prompt === node.prompt &&
      nextNode.title === node.title
    ) {
      return node;
    }
    updatedNodes.push(nextNode);
    return nextNode;
  });

  if (updatedNodes.length === 0) {
    return { changed: false, snapshot, updatedNodes: [] };
  }

  return {
    changed: true,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
    updatedNodes,
  };
}

function normalizeSeedEdges(
  existingEdges: readonly WorkflowGraphEdge[],
  addedNodes: readonly WorkflowGraphNode[],
  seedEdges: readonly WorkflowGraphEdge[],
): WorkflowGraphEdge[] {
  const edges = seedEdges.map((edge) => ({ from: edge.from, to: edge.to }));
  const knownEdgeIds = new Set([...existingEdges, ...edges].map(edgeId));
  for (const node of addedNodes) {
    for (const dependencyId of node.dependsOn) {
      const edge = { from: dependencyId, to: node.id };
      const id = edgeId(edge);
      if (knownEdgeIds.has(id)) continue;
      edges.push(edge);
      knownEdgeIds.add(id);
    }
  }
  return edges;
}

function validateAddedEdges(
  existingNodes: readonly WorkflowGraphNode[],
  existingEdges: readonly WorkflowGraphEdge[],
  addedNodes: readonly WorkflowGraphNode[],
  addedEdges: readonly WorkflowGraphEdge[],
): void {
  const nodeIds = new Set([...existingNodes, ...addedNodes].map((node) => node.id));
  const seenEdgeIds = new Set(existingEdges.map(edgeId));
  const pendingEdges = [...existingEdges];
  for (const edge of addedEdges) {
    if (edge.from === edge.to) {
      throw new Error(`Workflow graph seed returned a self-loop edge: ${edge.from} -> ${edge.to}`);
    }
    if (!nodeIds.has(edge.from)) {
      throw new Error(
        `Workflow graph seed returned an edge with unknown source node: ${edge.from}`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Workflow graph seed returned an edge with unknown target node: ${edge.to}`);
    }
    const id = edgeId(edge);
    if (seenEdgeIds.has(id)) {
      throw new Error(`Workflow graph seed returned duplicate edge: ${id}`);
    }
    if (wouldFormCycle(pendingEdges, edge)) {
      throw new Error(`Workflow graph seed returned an edge that would create a cycle: ${id}`);
    }
    seenEdgeIds.add(id);
    pendingEdges.push(edge);
  }
}

function wouldFormCycle(edges: readonly WorkflowGraphEdge[], newEdge: WorkflowGraphEdge): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const visited = new Set<string>();
  const queue = [newEdge.to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newEdge.from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

function edgeId(edge: WorkflowGraphEdge): string {
  return `${edge.from}->${edge.to}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
