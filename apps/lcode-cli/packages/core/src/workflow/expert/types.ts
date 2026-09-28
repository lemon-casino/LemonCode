import type {
  ExpertWorkflowRunSnapshot,
  SessionEvent,
  TraceContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowRunStatus,
  WorkflowStorePort,
} from "@lcode/contracts";

export interface ExpertWorkflowAgentRunInput {
  abortSignal?: AbortSignal;
  activityId: string;
  cwd: string;
  onChildSessionStarted?: (event: ExpertWorkflowChildSessionStartedEvent) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  prompt: string;
  runId: string;
  task: string;
  traceContext?: TraceContext;
  workflowKind?: string;
}

export interface ExpertWorkflowChildSessionStartedEvent {
  model?: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface ExpertWorkflowAgentRunResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface ExpertWorkflowAgentRunner {
  run(input: ExpertWorkflowAgentRunInput): Promise<ExpertWorkflowAgentRunResult>;
}

export interface ExpertWorkflowRuntimeDeps {
  agentRunner: ExpertWorkflowAgentRunner;
  createActivityId?: () => string;
  createRunId?: () => string;
  definition?: WorkflowDefinition;
  now?: () => Date;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  store: WorkflowStorePort;
}

export interface ExpertWorkflowRunOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  sessionId?: string;
  task: string;
  traceContext?: TraceContext;
  workflowKind?: string;
}

export interface ExpertWorkflowLookupOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  runId?: string;
  workflowKind?: string;
}

export interface ExpertWorkflowRetryOptions extends ExpertWorkflowLookupOptions {
  activityId?: string;
  nodeId?: string;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  phase?: string;
  traceContext?: TraceContext;
}

export interface ExpertWorkflowListOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  limit?: number;
  workflowKind?: string;
}

export interface ExpertWorkflowEventsOptions {
  abortSignal?: AbortSignal;
  limit?: number;
  runId: string;
}

export interface ExpertWorkflowCommandResult {
  reportPath?: string;
  response: string;
  runId?: string;
  snapshot?: ExpertWorkflowRunSnapshot;
  status?: WorkflowRunStatus;
  traceId?: string;
}

export interface ExpertPhaseRunResult {
  response: string;
  snapshot: ExpertWorkflowRunSnapshot;
}

export type WorkflowAgentRunInput = ExpertWorkflowAgentRunInput;
export type WorkflowAgentRunResult = ExpertWorkflowAgentRunResult;
export type WorkflowAgentRunner = ExpertWorkflowAgentRunner;
export type WorkflowRuntimeDeps = ExpertWorkflowRuntimeDeps;
export type WorkflowRunOptions = ExpertWorkflowRunOptions;
export type WorkflowLookupOptions = ExpertWorkflowLookupOptions;
export type WorkflowRetryOptions = ExpertWorkflowRetryOptions;
export type WorkflowListOptions = ExpertWorkflowListOptions;
export type WorkflowEventsOptions = ExpertWorkflowEventsOptions;
export type WorkflowCommandResult = ExpertWorkflowCommandResult;
