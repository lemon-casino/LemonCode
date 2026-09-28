import {
  deriveWorkflowSessionLinks,
  type WorkflowActivitySnapshot,
  type WorkflowGraphCollection,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowGraphSeed,
  WorkflowGraphSeedSchema,
  type WorkflowNodePromptUpdate,
  WorkflowNodePromptUpdateSetSchema,
  type WorkflowNodeStatus,
  type WorkflowPhaseSnapshot,
  type WorkflowRunSnapshot,
} from "@lcode/contracts";

export interface WorkflowGraphNodeChange {
  nodeId: string;
  phase?: string;
  status: WorkflowNodeStatus;
}

export interface WorkflowSnapshotLifecycleResult<TSnapshot extends WorkflowRunSnapshot> {
  activityIds: string[];
  changed: boolean;
  nodeChanges: WorkflowGraphNodeChange[];
  phaseIds: string[];
  snapshot: TSnapshot;
}

export interface ReconcileWorkflowSnapshotForResumeOptions {
  nodeIds?: Iterable<string>;
  reason?: string;
  resetActivities?: boolean;
  resetPhases?: boolean;
  timestamp: string;
}

export interface CancelWorkflowSnapshotOptions {
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeOptions {
  maxReopens?: number;
  nodeId: string;
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  nodeChange: WorkflowGraphNodeChange;
  reopenAttempts: number;
  snapshot: TSnapshot;
}

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

const DEFAULT_RESUME_RESET_REASON =
  "Reset during workflow resume because the previous process stopped before completion.";
const DEFAULT_CANCEL_REASON = "Workflow cancelled.";
const DEFAULT_REOPEN_REASON = "Reopened by workflow critic.";
const CANCELLABLE_STATUSES = new Set<WorkflowNodeStatus>(["active", "pending"]);
const REOPENABLE_STATUSES = new Set<WorkflowNodeStatus>(["completed", "failed", "skipped"]);

export function reconcileWorkflowSnapshotForResume<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReconcileWorkflowSnapshotForResumeOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_RESUME_RESET_REASON;
  const nodeScope = options.nodeIds ? new Set(options.nodeIds) : undefined;
  const resetActivities = options.resetActivities ?? true;
  const resetPhases = options.resetPhases ?? true;
  const nodeChanges: WorkflowGraphNodeChange[] = [];
  const resetPhaseIdsFromNodes = new Set<string>();

  const nodes = snapshot.graph.nodes.map((node) => {
    if (node.status !== "active" || !isInScope(node.id, nodeScope)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "pending"));
    if (node.phase) {
      resetPhaseIdsFromNodes.add(node.phase);
    }
    return {
      ...node,
      error: reason,
      status: "pending" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (
      !resetPhases ||
      phase.status !== "active" ||
      !shouldRepairPhase(phase.phase, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return resetPhaseForRetry(phase, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (
      !resetActivities ||
      activity.status !== "active" ||
      !shouldRepairActivity(activity, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  const changed = nodeChanges.length > 0 || phaseIds.length > 0 || activityIds.length > 0;
  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function cancelWorkflowSnapshot<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: CancelWorkflowSnapshotOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_CANCEL_REASON;
  const nodeChanges: WorkflowGraphNodeChange[] = [];

  const nodes = snapshot.graph.nodes.map((node) => {
    if (!CANCELLABLE_STATUSES.has(node.status)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "cancelled"));
    return {
      ...node,
      error: reason,
      status: "cancelled" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (!CANCELLABLE_STATUSES.has(phase.status)) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return closePhase(phase, "cancelled", options.timestamp, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (!CANCELLABLE_STATUSES.has(activity.status)) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  const changed =
    snapshot.status !== "cancelled" ||
    snapshot.completedAt !== options.timestamp ||
    nodeChanges.length > 0 ||
    phaseIds.length > 0 ||
    activityIds.length > 0;

  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          completedAt: options.timestamp,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          status: "cancelled",
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function reopenWorkflowGraphNode<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReopenWorkflowGraphNodeOptions,
): ReopenWorkflowGraphNodeResult<TSnapshot> {
  const node = snapshot.graph.nodes.find((item) => item.id === options.nodeId);
  if (!node) {
    throw new Error(`Workflow graph node not found: ${options.nodeId}`);
  }
  if (!REOPENABLE_STATUSES.has(node.status)) {
    throw new Error(
      `Cannot reopen workflow node "${options.nodeId}": status is "${node.status}", expected completed, failed, or skipped`,
    );
  }

  const maxReopens = options.maxReopens ?? 2;
  const reopenAttempts = node.reopenAttempts ?? 0;
  if (reopenAttempts >= maxReopens) {
    throw new Error(
      `Workflow node "${options.nodeId}" already reopened ${reopenAttempts}x (max=${maxReopens})`,
    );
  }

  const nextAttempts = reopenAttempts + 1;
  const reason = options.reason ?? DEFAULT_REOPEN_REASON;
  const nodes = snapshot.graph.nodes.map((item) =>
    item.id === options.nodeId
      ? {
          ...item,
          error: reason,
          reopenAttempts: nextAttempts,
          status: "pending" as const,
        }
      : item,
  );

  return {
    changed: true,
    nodeChange: nodeChange(node, "pending"),
    reopenAttempts: nextAttempts,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
  };
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

function isInScope(value: string, scope: ReadonlySet<string> | undefined): boolean {
  return !scope || scope.has(value);
}

function shouldRepairPhase(
  phase: string,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  return resetPhaseIdsFromNodes.has(phase);
}

function shouldRepairActivity(
  activity: WorkflowActivitySnapshot,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  if (activity.nodeId && nodeScope.has(activity.nodeId)) return true;
  return resetPhaseIdsFromNodes.has(activity.phase);
}

function nodeChange(node: WorkflowGraphNode, status: WorkflowNodeStatus): WorkflowGraphNodeChange {
  return {
    nodeId: node.id,
    ...(node.phase ? { phase: node.phase } : {}),
    status,
  };
}

function resetPhaseForRetry(phase: WorkflowPhaseSnapshot, reason: string): WorkflowPhaseSnapshot {
  return {
    error: reason,
    phase: phase.phase,
    status: "pending",
  };
}

function closePhase(
  phase: WorkflowPhaseSnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    ...phase,
    completedAt: phase.completedAt ?? timestamp,
    error: phase.error ?? reason,
    status,
  };
}

function closeActivity(
  activity: WorkflowActivitySnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowActivitySnapshot {
  return {
    ...activity,
    completedAt: activity.completedAt ?? timestamp,
    error: activity.error ?? reason,
    status,
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
