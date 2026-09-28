import { reconcileWorkflowSnapshotForResume } from "./lifecycle.js";
import { checkCollectionPlanners } from "./scheduler/collection-planner.js";
import type { WorkflowCollectionPlannerRuntime } from "./scheduler/collection-runtime.js";
import { WorkflowSchedulerEventLog } from "./scheduler/events.js";
import {
  areExecutableNodesComplete,
  blockedExecutableNodes,
  orderedReadyExecutableNodes,
  readyExecutableNodes,
} from "./scheduler/graph.js";
import { runWorkflowNode, type WorkflowNodeRunnerRuntime } from "./scheduler/node-runner.js";
import type {
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerRunResult,
  WorkflowSchedulerNodePromise,
} from "./scheduler/types.js";

export { deriveWorkflowRunSchedulerState, deriveWorkflowSchedulerState } from "@lcode/contracts";
export type { WorkflowSchedulerDerivedNode, WorkflowSchedulerState } from "@lcode/contracts";
export type {
  WorkflowGraphSchedulerActivityInput,
  WorkflowGraphSchedulerActivityResult,
  WorkflowGraphSchedulerChildSessionStartedEvent,
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerPlannerInput,
  WorkflowGraphSchedulerPlannerRunner,
  WorkflowGraphSchedulerPlannerRunResult,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerRunResult,
  WorkflowGraphSchedulerRunner,
} from "./scheduler/types.js";

export class WorkflowGraphScheduler {
  private readonly createActivityId: () => string;
  private readonly eventLog: WorkflowSchedulerEventLog;
  private readonly plannerRunner?: WorkflowGraphSchedulerDeps["plannerRunner"];
  private readonly runner: WorkflowGraphSchedulerDeps["runner"];
  private readonly writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  private readonly writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];

  constructor(deps: WorkflowGraphSchedulerDeps) {
    this.createActivityId = deps.createActivityId;
    this.eventLog = new WorkflowSchedulerEventLog(deps);
    this.plannerRunner = deps.plannerRunner;
    this.runner = deps.runner;
    this.writeArtifact = deps.writeArtifact;
    this.writeSnapshot = deps.writeSnapshot;
  }

  async run(options: WorkflowGraphSchedulerRunOptions): Promise<WorkflowGraphSchedulerRunResult> {
    const executableNodeIds = new Set(
      options.executableNodeIds ?? options.snapshot.graph.nodes.map((node) => node.id),
    );
    const resumeRepair = reconcileWorkflowSnapshotForResume(options.snapshot, {
      nodeIds: executableNodeIds,
      resetPhases: false,
      timestamp: this.eventLog.timestamp(),
    });
    let snapshot = resumeRepair.snapshot;
    if (resumeRepair.changed) {
      await this.writeSnapshot(snapshot, { signal: options.abortSignal });
    }

    const maxConcurrent = Math.max(1, snapshot.strategy.executor.maxConcurrentLoops);
    const maxConsecutiveErrors = Math.max(1, snapshot.strategy.executor.maxConsecutiveErrors);
    const active = new Map<string, WorkflowSchedulerNodePromise>();
    let consecutiveErrors = 0;
    let frontierKey = "";

    while (true) {
      throwIfAborted(options.abortSignal);
      const plannerResult = await checkCollectionPlanners(
        snapshot,
        executableNodeIds,
        options,
        this.collectionPlannerRuntime(),
      );
      snapshot = plannerResult.snapshot;
      for (const nodeId of plannerResult.addedNodeIds) {
        executableNodeIds.add(nodeId);
      }
      if (plannerResult.plannersRan > 0) {
        frontierKey = "";
      }

      frontierKey = await this.emitFrontierChangedIfNeeded(
        snapshot,
        executableNodeIds,
        frontierKey,
        options.abortSignal,
      );

      if (
        areExecutableNodesComplete(
          snapshot.graph,
          executableNodeIds,
          Boolean(this.plannerRunner),
        ) &&
        active.size === 0
      ) {
        await this.eventLog.emitEvent(snapshot, "executor_completed", {
          message: `${options.phase} scheduler completed.`,
          phase: options.phase,
          signal: options.abortSignal,
        });
        return { reason: "completed", snapshot, status: "completed" };
      }

      if (consecutiveErrors >= maxConsecutiveErrors) {
        if (active.size > 0) {
          await Promise.all(active.values());
          active.clear();
        }
        await this.eventLog.emitEvent(snapshot, "executor_paused", {
          message: `${options.phase} scheduler paused after ${consecutiveErrors} consecutive node error(s).`,
          payload: { consecutiveErrors },
          phase: options.phase,
          signal: options.abortSignal,
        });
        return { reason: "error_threshold", snapshot, status: "paused" };
      }

      const readyNodes = orderedReadyExecutableNodes(snapshot.graph, executableNodeIds).filter(
        (node) => !active.has(node.id),
      );
      let dispatched = 0;
      for (const node of readyNodes) {
        if (active.size >= maxConcurrent) break;
        const promise = runWorkflowNode(
          {
            getSnapshot: () => snapshot,
            setSnapshot: (nextSnapshot) => {
              snapshot = nextSnapshot;
              return nextSnapshot;
            },
          },
          node,
          options,
          maxConsecutiveErrors,
          this.nodeRunnerRuntime(),
        );
        active.set(node.id, promise);
        snapshot = (await promise.started).snapshot;
        dispatched++;
      }

      if (dispatched > 0) continue;

      if (active.size > 0) {
        const outcome = await Promise.race(active.values());
        active.delete(outcome.nodeId);
        consecutiveErrors = outcome.ok ? 0 : consecutiveErrors + 1;
        continue;
      }

      await this.eventLog.emitEvent(snapshot, "executor_paused", {
        message: `${options.phase} scheduler paused because pending nodes are blocked.`,
        payload: {
          blockedNodes: blockedExecutableNodes(snapshot.graph, executableNodeIds),
        },
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { reason: "deadlock", snapshot, status: "paused" };
    }
  }

  private collectionPlannerRuntime(): WorkflowCollectionPlannerRuntime {
    return {
      createActivityId: this.createActivityId,
      eventLog: this.eventLog,
      plannerRunner: this.plannerRunner,
      writeArtifact: this.writeArtifact,
      writeSnapshot: this.writeSnapshot,
    };
  }

  private nodeRunnerRuntime(): WorkflowNodeRunnerRuntime {
    return {
      createActivityId: this.createActivityId,
      eventLog: this.eventLog,
      runner: this.runner,
      writeArtifact: this.writeArtifact,
      writeSnapshot: this.writeSnapshot,
    };
  }

  private async emitFrontierChangedIfNeeded(
    snapshot: WorkflowGraphSchedulerRunResult["snapshot"],
    executableNodeIds: Set<string>,
    previousKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const readyNodeIds = readyExecutableNodes(snapshot.graph, executableNodeIds).map(
      (node) => node.id,
    );
    const activeNodeIds = snapshot.graph.nodes
      .filter((node) => executableNodeIds.has(node.id) && node.status === "active")
      .map((node) => node.id);
    const blockedNodes = blockedExecutableNodes(snapshot.graph, executableNodeIds);
    const nextKey = JSON.stringify({ activeNodeIds, blockedNodes, readyNodeIds });
    if (nextKey === previousKey) return previousKey;
    await this.eventLog.emitEvent(snapshot, "frontier_changed", {
      message: "Workflow scheduler frontier changed.",
      payload: { activeNodeIds, blockedNodes, readyNodeIds },
      signal,
    });
    return nextKey;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workflow scheduler aborted");
}
