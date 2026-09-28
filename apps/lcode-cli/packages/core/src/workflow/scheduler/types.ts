import type {
  SessionEvent,
  TraceContext,
  WorkflowEvent,
  WorkflowGraph,
  WorkflowGraphCollection,
  WorkflowGraphCollectionStatus,
  WorkflowGraphNode,
  WorkflowGraphPlannerResult,
  WorkflowGraphRecord,
  WorkflowRunSnapshot,
} from "@lcode/contracts";

export interface WorkflowGraphSchedulerActivityInput {
  abortSignal?: AbortSignal;
  activityId: string;
  cwd: string;
  node: WorkflowGraphNode;
  onChildSessionStarted?: (
    event: WorkflowGraphSchedulerChildSessionStartedEvent,
  ) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  prompt: string;
  runId: string;
  task: string;
  traceContext?: TraceContext;
}

export interface WorkflowGraphSchedulerActivityResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface WorkflowGraphSchedulerChildSessionStartedEvent {
  model?: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface WorkflowGraphSchedulerRunner {
  run(input: WorkflowGraphSchedulerActivityInput): Promise<WorkflowGraphSchedulerActivityResult>;
}

export interface WorkflowGraphSchedulerPlannerInput {
  abortSignal?: AbortSignal;
  activityId: string;
  collection: WorkflowGraphCollection;
  cwd: string;
  graph: WorkflowGraph;
  onChildSessionStarted?: (
    event: WorkflowGraphSchedulerChildSessionStartedEvent,
  ) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  prompt: string;
  runId: string;
  snapshot: WorkflowRunSnapshot;
  task: string;
  traceContext?: TraceContext;
}

export interface WorkflowGraphSchedulerPlannerRunResult extends WorkflowGraphPlannerResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface WorkflowGraphSchedulerPlannerRunner {
  run(input: WorkflowGraphSchedulerPlannerInput): Promise<WorkflowGraphSchedulerPlannerRunResult>;
}

export interface WorkflowGraphSchedulerDeps {
  appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void>;
  appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  createActivityId: () => string;
  now: () => Date;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  plannerRunner?: WorkflowGraphSchedulerPlannerRunner;
  runner: WorkflowGraphSchedulerRunner;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeSnapshot(snapshot: WorkflowRunSnapshot, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface WorkflowGraphSchedulerRunOptions {
  abortSignal?: AbortSignal;
  artifactDirectory?: string;
  buildPrompt?: (input: {
    node: WorkflowGraphNode;
    phase: string;
    snapshot: WorkflowRunSnapshot;
  }) => string;
  cwd: string;
  executableNodeIds?: Iterable<string>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  snapshot: WorkflowRunSnapshot;
  traceContext?: TraceContext;
}

export interface WorkflowGraphSchedulerRunResult {
  reason: "completed" | "deadlock" | "error_threshold";
  snapshot: WorkflowRunSnapshot;
  status: "completed" | "paused";
}

export interface NodeRunStarted {
  snapshot: WorkflowRunSnapshot;
}

export interface NodeRunOutcome {
  nodeId: string;
  ok: boolean;
  snapshot: WorkflowRunSnapshot;
}

export interface WorkflowGraphSchedulerSnapshotAccess {
  getSnapshot(): WorkflowRunSnapshot;
  setSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot;
}

export interface AppliedPlannerExpansion {
  addedEdges: WorkflowGraphRecordEdge[];
  addedNodes: WorkflowGraphNode[];
  collection: SchedulerCollection;
  snapshot: WorkflowRunSnapshot;
}

export type WorkflowGraphRecordEdge = WorkflowGraph["edges"][number];

export type SchedulerCollection = WorkflowGraphCollection & {
  analyzedNodeIds: string[];
  errorCount: number;
  exhausted: boolean;
  explorable: boolean;
  nodeIds: string[];
  plannerRuns: number;
  status: WorkflowGraphCollectionStatus;
};

export type WorkflowSchedulerNodePromise = Promise<NodeRunOutcome> & {
  started: Promise<NodeRunStarted>;
};
