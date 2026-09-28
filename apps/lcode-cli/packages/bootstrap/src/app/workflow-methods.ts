import type { ExpertWorkflowRuntime } from "@lcode/core";
import type { SessionId, TraceContext, WorkflowDefinition } from "@lcode/contracts";
import type { PrepareUserExecutionBoundary, LCodeApp } from "./types.js";

export type WorkflowFacade = Pick<
  LCodeApp,
  | "expertWorkflowStatus"
  | "workflowStatus"
  | "retryWorkflow"
  | "listExpertWorkflows"
  | "listWorkflows"
  | "readExpertWorkflowEvents"
  | "readWorkflowEvents"
  | "resumeExpertWorkflow"
  | "resumeWorkflow"
  | "stopExpertWorkflow"
  | "stopWorkflow"
  | "runExpertWorkflowBackground"
  | "runWorkflowBackground"
  | "runExpertWorkflow"
  | "runWorkflow"
>;

interface CreateWorkflowMethodsDeps {
  builtInExpertWorkflowDefinition: WorkflowDefinition;
  createStartInput(
    input: { definitionId?: string; task: string; workflowKind?: string },
    defaultKind?: string,
  ): Promise<{ definition: WorkflowDefinition; workflow: ExpertWorkflowRuntime }>;
  listWorkflowRuns: NonNullable<WorkflowFacade["listWorkflows"]>;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  persistWorkflowActivity(
    definition: WorkflowDefinition,
    task: string,
    traceContext: TraceContext,
  ): Promise<void>;
  sessionId: SessionId;
  switchWorkflowToYolo(): void;
  traceContext: TraceContext;
  workflowRuntimeForLookup(input?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime>;
  workingDirectory: string;
}

export function createWorkflowMethods(deps: CreateWorkflowMethodsDeps): WorkflowFacade {
  const { builtInExpertWorkflowDefinition } = deps;
  return {
    expertWorkflowStatus: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
        })
      ).status({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      }),
    workflowStatus: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).status({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind,
      }),
    retryWorkflow: async (options) => {
      await deps.prepareUserExecutionBoundary(options);
      return (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).retry({
        abortSignal: options?.abortSignal,
        activityId: options?.activityId,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        nodeId: options?.nodeId,
        onEvent: options?.onEvent,
        phase: options?.phase,
        runId: options?.runId,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: options?.workflowKind,
      });
    },
    listExpertWorkflows: async (options) =>
      deps.listWorkflowRuns({
        abortSignal: options?.abortSignal,
        definitionId: options?.definitionId,
        limit: options?.limit,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      }),
    listWorkflows: deps.listWorkflowRuns,
    readExpertWorkflowEvents: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options.abortSignal,
          runId: options.runId,
        })
      ).events({
        abortSignal: options.abortSignal,
        limit: options.limit,
        runId: options.runId,
      }),
    readWorkflowEvents: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options.abortSignal,
          runId: options.runId,
        })
      ).events({
        abortSignal: options.abortSignal,
        limit: options.limit,
        runId: options.runId,
      }),
    resumeExpertWorkflow: async (options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      return (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
        })
      ).resume({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        onEvent: options?.onEvent,
        runId: options?.runId,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      });
    },
    resumeWorkflow: async (options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      return (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).resume({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        onEvent: options?.onEvent,
        runId: options?.runId,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: options?.workflowKind,
      });
    },
    stopExpertWorkflow: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
        })
      ).cancel({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      }),
    stopWorkflow: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).cancel({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind,
      }),
    runExpertWorkflowBackground: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(
        input,
        builtInExpertWorkflowDefinition.kind,
      );
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.startBackground({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
    runWorkflowBackground: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(input);
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.startBackground({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId ?? definition.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
    runExpertWorkflow: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(
        input,
        builtInExpertWorkflowDefinition.kind,
      );
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.start({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId ?? definition.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
    runWorkflow: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(input);
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.start({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId ?? definition.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
  };
}
