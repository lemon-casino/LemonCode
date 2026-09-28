import type { WorkflowGraphCollection, WorkflowRunSnapshot } from "@lcode/contracts";
import type { WorkflowCollectionPlannerRuntime } from "./collection-runtime.js";
import { edgeId, updateGraphCollection } from "./graph.js";
import type {
  AppliedPlannerExpansion,
  SchedulerCollection,
  WorkflowGraphSchedulerRunOptions,
} from "./types.js";

export async function emitExpansionEvents(
  snapshot: WorkflowRunSnapshot,
  expansion: AppliedPlannerExpansion,
  collectionId: string,
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
): Promise<void> {
  if (expansion.addedNodes.length > 0 || expansion.addedEdges.length > 0) {
    await runtime.eventLog.emitEvent(snapshot, "graph_expanded", {
      message: `Graph expanded for collection: ${collectionId}`,
      payload: {
        collectionId,
        edgeIds: expansion.addedEdges.map(edgeId),
        nodeIds: expansion.addedNodes.map((node) => node.id),
      },
      phase: options.phase,
      signal: options.abortSignal,
    });
  }
  if (expansion.collection.exhausted || expansion.collection.status === "exhausted") {
    await runtime.eventLog.emitEvent(snapshot, "collection_exhausted", {
      message: `Collection exhausted: ${collectionId}`,
      payload: { collectionId },
      phase: options.phase,
      signal: options.abortSignal,
    });
  }
}

export async function exhaustCollection(
  snapshot: WorkflowRunSnapshot,
  collection: SchedulerCollection,
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
  payload: Record<string, unknown>,
): Promise<WorkflowRunSnapshot> {
  const exhaustedCollection: WorkflowGraphCollection = {
    ...collection,
    exhausted: true,
    status: "exhausted",
  };
  const exhaustedSnapshot = updateGraphCollection(
    snapshot,
    collection.collectionId,
    exhaustedCollection,
    runtime.eventLog.timestamp(),
  );
  await runtime.writeSnapshot(exhaustedSnapshot, { signal: options.abortSignal });
  await runtime.eventLog.appendCollectionRecord(
    exhaustedSnapshot,
    exhaustedCollection,
    options.abortSignal,
  );
  await runtime.eventLog.emitEvent(exhaustedSnapshot, "collection_exhausted", {
    message: `Collection exhausted: ${collection.collectionId}`,
    payload: {
      collectionId: collection.collectionId,
      ...payload,
    },
    phase: options.phase,
    signal: options.abortSignal,
  });
  return exhaustedSnapshot;
}
