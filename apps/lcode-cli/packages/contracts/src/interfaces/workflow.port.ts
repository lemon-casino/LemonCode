// ============================================================
// Workflow Port - background workflow launch boundary
// ============================================================

import type { WorkflowInput, WorkflowOutput } from "../tools/workflow.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface WorkflowStartRequest extends WorkflowInput {
  parentToolCallId: ToolCallId | string;
  sessionId: SessionId;
  trace: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
  workspaceRoot: string;
}

export interface WorkflowStartOptions {
  signal?: AbortSignal;
}

export type WorkflowTaskStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface WorkflowTaskSnapshot {
  completedAt?: Date;
  description?: string;
  error?: string;
  name?: string;
  output?: WorkflowOutput;
  runId: string;
  startedAt: Date;
  status: WorkflowTaskStatus;
  taskId: string;
}

export interface WorkflowPort {
  start(request: WorkflowStartRequest, options?: WorkflowStartOptions): Promise<WorkflowOutput>;
  getTask?(taskId: string): Promise<WorkflowTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowTaskSnapshot | undefined>;
}
