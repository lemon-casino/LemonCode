import { z } from "zod";
import {
  WorkflowActivitySnapshotSchema,
  WorkflowArtifactSchema,
  WorkflowPhaseSnapshotSchema,
  WorkflowFailureSchema,
  WorkflowRecoveryActionSchema,
  WorkflowSessionLinkSchema,
} from "./activity.js";
import {
  WorkflowPhaseIdSchema,
  WorkflowKindSchema,
  WorkflowRunStatusSchema,
  WorkflowStrategySchema,
} from "./definition.js";
import type { WorkflowKind, WorkflowRunStatus, WorkflowDefinition } from "./definition.js";
import { WorkflowGraphSchema } from "./graph.js";
import type { WorkflowGraphRecord } from "./graph.js";

export const WorkflowRunSnapshotSchema = z.object({
  activities: z.array(WorkflowActivitySnapshotSchema).default([]),
  artifacts: z.array(WorkflowArtifactSchema),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  currentPhase: WorkflowPhaseIdSchema.optional(),
  cwd: z.string(),
  definitionId: z.string().min(1).optional(),
  definitionVersion: z.string().min(1).optional(),
  graph: WorkflowGraphSchema,
  kind: WorkflowKindSchema,
  phaseOrder: z.array(WorkflowPhaseIdSchema),
  phases: z.array(WorkflowPhaseSnapshotSchema),
  failure: WorkflowFailureSchema.optional(),
  pauseReason: z.string().optional(),
  reportPath: z.string().optional(),
  recoveryActions: z.array(WorkflowRecoveryActionSchema).default([]),
  runId: z.string(),
  schemaVersion: z.literal(1),
  sessionId: z.string().optional(),
  sessionLinks: z.array(WorkflowSessionLinkSchema).default([]),
  startedAt: z.string().optional(),
  status: WorkflowRunStatusSchema,
  strategy: WorkflowStrategySchema,
  task: z.string(),
  traceId: z.string().optional(),
  updatedAt: z.string(),
});

export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

export const ExpertWorkflowRunSnapshotSchema = WorkflowRunSnapshotSchema;

export type ExpertWorkflowRunSnapshot = WorkflowRunSnapshot;

export const WorkflowEventTypeSchema = z.enum([
  "run_started",
  "run_completed",
  "run_failed",
  "workflow_paused",
  "workflow_retry_started",
  "workflow_session_linked",
  "run_cancelled",
  "phase_started",
  "phase_completed",
  "phase_failed",
  "artifact_written",
  "graph_updated",
  "node_started",
  "node_completed",
  "node_failed",
  "frontier_changed",
  "executor_paused",
  "executor_completed",
  "planner_started",
  "planner_completed",
  "planner_failed",
  "graph_expanded",
  "collection_exhausted",
  "critic_started",
  "critic_passed",
  "critic_failed",
  "node_reopened",
  "critic_iteration_limit_reached",
]);

export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const WorkflowEventSchema = z.object({
  kind: WorkflowKindSchema,
  message: z.string().optional(),
  nodeId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  runId: z.string(),
  timestamp: z.string(),
  type: WorkflowEventTypeSchema,
});

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export interface WorkflowRunListItem {
  completedAt?: string;
  createdAt: string;
  cwd: string;
  kind: WorkflowKind;
  runId: string;
  status: WorkflowRunStatus;
  task: string;
  updatedAt: string;
}

export interface WorkflowStorePort {
  appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void>;
  appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listRuns(
    options?: { cwd?: string; kind?: WorkflowKind; limit?: number },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunListItem[]>;
  readEvents(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowEvent[]>;
  readLatestRun(
    options?: { cwd?: string; kind?: WorkflowKind },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | null>;
  readRun(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunSnapshot | null>;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeReport(
    runId: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeSnapshot(snapshot: WorkflowRunSnapshot, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface WorkflowDefinitionStorePort {
  listDefinitions(options?: { signal?: AbortSignal }): Promise<WorkflowDefinition[]>;
  readDefinition(
    definitionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDefinition | null>;
}
