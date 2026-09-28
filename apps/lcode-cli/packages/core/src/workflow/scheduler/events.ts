import type {
  WorkflowEvent,
  WorkflowGraphCollection,
  WorkflowNodeStatus,
  WorkflowRunSnapshot,
} from "@lcode/contracts";
import { edgeId } from "./graph.js";
import type { AppliedPlannerExpansion, WorkflowGraphSchedulerDeps } from "./types.js";

export class WorkflowSchedulerEventLog {
  private readonly appendEvent: WorkflowGraphSchedulerDeps["appendEvent"];
  private readonly appendGraphRecord: WorkflowGraphSchedulerDeps["appendGraphRecord"];
  private readonly now: () => Date;
  private readonly onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;

  constructor(deps: WorkflowGraphSchedulerDeps) {
    this.appendEvent = deps.appendEvent;
    this.appendGraphRecord = deps.appendGraphRecord;
    this.now = deps.now;
    this.onWorkflowEvent = deps.onWorkflowEvent;
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  async appendGraphStatus(
    snapshot: WorkflowRunSnapshot,
    nodeId: string,
    phase: string,
    status: WorkflowNodeStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.appendGraphRecord(
      snapshot.runId,
      {
        nodeId,
        phase,
        recordType: "op",
        runId: snapshot.runId,
        status,
        timestamp: this.timestamp(),
        type: "update_status",
      },
      { signal },
    );
  }

  async appendCollectionRecord(
    snapshot: WorkflowRunSnapshot,
    collection: WorkflowGraphCollection,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.appendGraphRecord(
      snapshot.runId,
      {
        collection,
        recordType: "collection",
        runId: snapshot.runId,
        timestamp: this.timestamp(),
      },
      { signal },
    );
  }

  async appendExpansionRecords(
    snapshot: WorkflowRunSnapshot,
    expansion: AppliedPlannerExpansion,
    phase: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const node of expansion.addedNodes) {
      await this.appendGraphRecord(
        snapshot.runId,
        {
          node,
          recordType: "node",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
    for (const edge of expansion.addedEdges) {
      await this.appendGraphRecord(
        snapshot.runId,
        {
          edge,
          recordType: "edge",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
    await this.appendCollectionRecord(snapshot, expansion.collection, signal);
    await this.appendGraphRecord(
      snapshot.runId,
      {
        collectionId: expansion.collection.collectionId,
        edgeIds: expansion.addedEdges.map(edgeId),
        nodeIds: expansion.addedNodes.map((node) => node.id),
        payload: {
          exhausted: expansion.collection.exhausted,
          plannerRuns: expansion.collection.plannerRuns,
          status: expansion.collection.status,
        },
        phase,
        recordType: "op",
        runId: snapshot.runId,
        timestamp: this.timestamp(),
        type: "graph_expanded",
      },
      { signal },
    );
  }

  async emitEvent(
    snapshot: WorkflowRunSnapshot,
    type: WorkflowEvent["type"],
    options: {
      message?: string;
      nodeId?: string;
      payload?: Record<string, unknown>;
      phase?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const event: WorkflowEvent = {
      kind: snapshot.kind,
      message: options.message,
      nodeId: options.nodeId,
      payload: options.payload,
      phase: options.phase,
      runId: snapshot.runId,
      timestamp: this.timestamp(),
      type,
    };
    await this.appendEvent(event, { signal: options.signal });
    await this.onWorkflowEvent?.(event);
  }
}
