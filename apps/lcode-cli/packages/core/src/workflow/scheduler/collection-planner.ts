import {
  createChildTraceContext,
  type WorkflowGraphCollection,
  type WorkflowRunSnapshot,
} from "@lcode/contracts";
import { emitExpansionEvents, exhaustCollection } from "./collection-events.js";
import type { WorkflowCollectionPlannerRuntime } from "./collection-runtime.js";
import {
  addArtifact,
  collectionFrontier,
  collectionNodeIdsForGraph,
  compactWorkflowPayload,
  graphCollections,
  isCollectionInPhase,
  nodeById,
  normalizeCollection,
  updateGraphCollection,
  upsertActivity,
} from "./graph.js";
import { applyPlannerExpansion } from "./planner-expansion.js";
import { buildDefaultPlannerPrompt, safeArtifactName } from "./prompts.js";
import type { SchedulerCollection, WorkflowGraphSchedulerRunOptions } from "./types.js";

export async function checkCollectionPlanners(
  snapshot: WorkflowRunSnapshot,
  executableNodeIds: Set<string>,
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
): Promise<{ addedNodeIds: string[]; plannersRan: number; snapshot: WorkflowRunSnapshot }> {
  if (!runtime.plannerRunner) {
    return { addedNodeIds: [], plannersRan: 0, snapshot };
  }

  let nextSnapshot = snapshot;
  const addedNodeIds: string[] = [];
  let plannersRan = 0;

  for (const collection of graphCollections(nextSnapshot.graph)) {
    throwIfAborted(options.abortSignal);
    if (
      !collection.explorable ||
      !isCollectionInPhase(collection, nextSnapshot.graph, executableNodeIds, options.phase)
    ) {
      continue;
    }

    const collectionNodeIds = collectionNodeIdsForGraph(collection, nextSnapshot.graph);
    const frontier = collectionFrontier(nextSnapshot.graph, collection);
    const completedNodeIds = collectionNodeIds.filter(
      (nodeId) => nodeById(nextSnapshot.graph, nodeId)?.status === "completed",
    );
    const unseenCompletions = completedNodeIds.filter(
      (nodeId) => !(collection.analyzedNodeIds ?? []).includes(nodeId),
    );

    if (unseenCompletions.length > 0) {
      nextSnapshot = updateGraphCollection(
        nextSnapshot,
        collection.collectionId,
        {
          lastCompletionAt: runtime.eventLog.timestamp(),
        },
        runtime.eventLog.timestamp(),
      );
    }

    const latestCollection =
      graphCollections(nextSnapshot.graph).find(
        (item) => item.collectionId === collection.collectionId,
      ) ?? collection;
    if (latestCollection.exhausted || latestCollection.status === "exhausted") {
      continue;
    }

    const shouldDeferInitialExpansion =
      frontier > 0 &&
      (latestCollection.plannerRuns ?? 0) === 0 &&
      (latestCollection.analyzedNodeIds ?? []).length === 0 &&
      unseenCompletions.length === 0;
    if (shouldDeferInitialExpansion) {
      nextSnapshot = updateGraphCollection(
        nextSnapshot,
        latestCollection.collectionId,
        { status: "active" },
        runtime.eventLog.timestamp(),
      );
      continue;
    }

    const frontierTarget =
      latestCollection.frontierTarget ?? nextSnapshot.strategy.executor.frontierTarget;
    if (frontier >= frontierTarget && unseenCompletions.length === 0) {
      nextSnapshot = updateGraphCollection(
        nextSnapshot,
        latestCollection.collectionId,
        { status: "active" },
        runtime.eventLog.timestamp(),
      );
      continue;
    }

    if ((latestCollection.plannerRuns ?? 0) >= nextSnapshot.strategy.executor.maxPlannerRuns) {
      nextSnapshot = await exhaustCollection(nextSnapshot, latestCollection, options, runtime, {
        reason: "max_planner_runs",
      });
      continue;
    }

    if ((latestCollection.errorCount ?? 0) >= nextSnapshot.strategy.executor.maxConsecutiveErrors) {
      nextSnapshot = await exhaustCollection(nextSnapshot, latestCollection, options, runtime, {
        reason: "planner_error_threshold",
      });
      continue;
    }

    const result = await runCollectionPlanner(
      nextSnapshot,
      latestCollection,
      unseenCompletions,
      options,
      runtime,
    );
    nextSnapshot = result.snapshot;
    addedNodeIds.push(...result.addedNodeIds);
    plannersRan++;
  }

  return { addedNodeIds, plannersRan, snapshot: nextSnapshot };
}

async function runCollectionPlanner(
  snapshot: WorkflowRunSnapshot,
  collection: SchedulerCollection,
  unseenCompletions: readonly string[],
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
): Promise<{ addedNodeIds: string[]; snapshot: WorkflowRunSnapshot }> {
  if (!runtime.plannerRunner) return { addedNodeIds: [], snapshot };

  const activityId = runtime.createActivityId();
  const startedAt = runtime.eventLog.timestamp();
  const plannerRuns = (collection.plannerRuns ?? 0) + 1;
  const inputArtifactPaths = snapshot.artifacts.map((artifact) => artifact.path);
  const traceContext = options.traceContext
    ? createChildTraceContext(options.traceContext, {
        attributes: {
          workflowActivityId: activityId,
          workflowCollectionId: collection.collectionId,
          workflowKind: snapshot.kind,
          workflowPhase: options.phase,
          workflowRunId: snapshot.runId,
        },
        sessionId: options.traceContext.sessionId,
      })
    : undefined;
  const activeCollection: SchedulerCollection = normalizeCollection({
    ...collection,
    plannerRuns,
    status: "active" as const,
  });
  const activeSnapshot = upsertActivity(
    updateGraphCollection(
      snapshot,
      collection.collectionId,
      activeCollection,
      runtime.eventLog.timestamp(),
    ),
    {
      activityId,
      inputArtifactPaths,
      kind: "planner_agent",
      outputArtifactPaths: [],
      parentSessionId: options.parentSessionId,
      phase: options.phase,
      startedAt,
      status: "active",
      traceId: traceContext?.traceId,
    },
    runtime.eventLog.timestamp(),
  );
  await runtime.writeSnapshot(activeSnapshot, { signal: options.abortSignal });
  await runtime.eventLog.appendCollectionRecord(
    activeSnapshot,
    activeCollection,
    options.abortSignal,
  );
  await runtime.eventLog.emitEvent(activeSnapshot, "planner_started", {
    message: `Planner started for collection: ${collection.collectionId}`,
    payload: {
      collectionId: collection.collectionId,
      frontier: collectionFrontier(activeSnapshot.graph, activeCollection),
      plannerRuns,
      unseenCompletions,
    },
    phase: options.phase,
    signal: options.abortSignal,
  });
  let plannerSnapshot = activeSnapshot;

  try {
    const plannerResult = await runtime.plannerRunner.run({
      abortSignal: options.abortSignal,
      activityId,
      collection: activeCollection,
      cwd: options.cwd,
      graph: activeSnapshot.graph,
      onChildSessionStarted: async (event) => {
        const currentActivity = plannerSnapshot.activities.find(
          (activity) => activity.activityId === activityId,
        );
        if (!currentActivity || currentActivity.status !== "active") return;
        plannerSnapshot = upsertActivity(
          plannerSnapshot,
          {
            ...currentActivity,
            ...(event.model ? { model: event.model } : {}),
            sessionId: event.sessionId,
            traceId: event.traceId ?? currentActivity.traceId,
            turnId: event.turnId ?? currentActivity.turnId,
          },
          runtime.eventLog.timestamp(),
        );
        await runtime.writeSnapshot(plannerSnapshot, { signal: options.abortSignal });
        await runtime.eventLog.emitEvent(plannerSnapshot, "workflow_session_linked", {
          message: `Workflow session linked: ${event.sessionId}`,
          payload: compactWorkflowPayload({
            activityId,
            collectionId: collection.collectionId,
            model: event.model,
            sessionId: event.sessionId,
            traceId: event.traceId,
            turnId: event.turnId,
          }),
          phase: options.phase,
          signal: options.abortSignal,
        });
      },
      onEvent: options.onEvent,
      parentSessionId: options.parentSessionId,
      phase: options.phase,
      prompt: buildDefaultPlannerPrompt(activeSnapshot, activeCollection, options.phase),
      runId: plannerSnapshot.runId,
      snapshot: plannerSnapshot,
      task: plannerSnapshot.task,
      traceContext,
    });
    const artifact = await runtime.writeArtifact(
      plannerSnapshot.runId,
      `${options.artifactDirectory ?? "artifacts/exec"}/planners/${safeArtifactName(collection.collectionId)}-${plannerRuns}.md`,
      plannerResult.response,
      { signal: options.abortSignal },
    );
    const expanded = applyPlannerExpansion(
      plannerSnapshot,
      activeCollection,
      plannerResult,
      unseenCompletions,
      runtime.eventLog.timestamp(),
    );
    const completedSnapshot = upsertActivity(
      addArtifact(
        expanded.snapshot,
        {
          contentType: "text/markdown",
          createdAt: runtime.eventLog.timestamp(),
          label: `Planner ${collection.collectionId}`,
          path: artifact.relativePath,
          phase: options.phase,
        },
        runtime.eventLog.timestamp(),
      ),
      {
        activityId,
        artifactPath: artifact.relativePath,
        completedAt: runtime.eventLog.timestamp(),
        inputArtifactPaths,
        kind: "planner_agent",
        outputArtifactPaths: [artifact.relativePath],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        ...(plannerResult.model ? { model: plannerResult.model } : {}),
        sessionId: plannerResult.sessionId,
        startedAt,
        status: "completed",
        traceId: plannerResult.traceId ?? traceContext?.traceId,
        turnId: plannerResult.turnId,
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(completedSnapshot, { signal: options.abortSignal });
    await runtime.eventLog.appendExpansionRecords(
      completedSnapshot,
      expanded,
      options.phase,
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(completedSnapshot, "planner_completed", {
      message: `Planner completed for collection: ${collection.collectionId}`,
      payload: {
        collectionId: collection.collectionId,
        edgeCount: expanded.addedEdges.length,
        nodeCount: expanded.addedNodes.length,
      },
      phase: options.phase,
      signal: options.abortSignal,
    });
    await emitExpansionEvents(
      completedSnapshot,
      expanded,
      collection.collectionId,
      options,
      runtime,
    );
    return {
      addedNodeIds: expanded.addedNodes.map((node) => node.id),
      snapshot: completedSnapshot,
    };
  } catch (error) {
    if (options.abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCount = (activeCollection.errorCount ?? 0) + 1;
    const currentActivity = plannerSnapshot.activities.find(
      (activity) => activity.activityId === activityId,
    );
    const exhausted = errorCount >= plannerSnapshot.strategy.executor.maxConsecutiveErrors;
    const failedCollection: WorkflowGraphCollection = {
      ...activeCollection,
      errorCount,
      exhausted,
      status: exhausted ? "exhausted" : "draining",
    };
    const failedSnapshot = upsertActivity(
      updateGraphCollection(
        plannerSnapshot,
        collection.collectionId,
        failedCollection,
        runtime.eventLog.timestamp(),
      ),
      {
        activityId,
        completedAt: runtime.eventLog.timestamp(),
        error: errorMessage,
        inputArtifactPaths,
        kind: "planner_agent",
        ...(currentActivity?.model ? { model: currentActivity.model } : {}),
        outputArtifactPaths: [],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
        startedAt,
        status: "failed",
        traceId: currentActivity?.traceId ?? traceContext?.traceId,
        ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(failedSnapshot, { signal: options.abortSignal });
    await runtime.eventLog.appendCollectionRecord(
      failedSnapshot,
      failedCollection,
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(failedSnapshot, "planner_failed", {
      message: errorMessage,
      payload: {
        collectionId: collection.collectionId,
        errorCount,
        exhausted,
      },
      phase: options.phase,
      signal: options.abortSignal,
    });
    if (exhausted) {
      await runtime.eventLog.emitEvent(failedSnapshot, "collection_exhausted", {
        message: `Collection exhausted: ${collection.collectionId}`,
        payload: {
          collectionId: collection.collectionId,
          reason: "planner_error_threshold",
        },
        phase: options.phase,
        signal: options.abortSignal,
      });
    }
    return { addedNodeIds: [], snapshot: failedSnapshot };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workflow scheduler aborted");
}
