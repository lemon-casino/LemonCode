import { cancelWorkflowSnapshot, reconcileWorkflowSnapshotForResume } from "../lifecycle.js";
import { formatExpertWorkflowStatus } from "./formatters.js";
import { isTerminalStatus } from "./ids.js";
import { ExpertWorkflowRuntimeContext, lifecyclePayload } from "./runtime-context.js";
import { prepareSnapshotForRetry } from "./retry-state.js";
import { continueRun } from "./run-loop.js";
import type {
  ExpertWorkflowCommandResult,
  ExpertWorkflowEventsOptions,
  ExpertWorkflowListOptions,
  ExpertWorkflowLookupOptions,
  ExpertWorkflowRetryOptions,
  ExpertWorkflowRunOptions,
  ExpertWorkflowRuntimeDeps,
} from "./types.js";
import type {
  SessionEvent,
  TraceContext,
  WorkflowEvent,
  WorkflowRunListItem,
} from "@lcode/contracts";

export class ExpertWorkflowRuntime {
  private readonly ctx: ExpertWorkflowRuntimeContext;

  constructor(deps: ExpertWorkflowRuntimeDeps) {
    this.ctx = new ExpertWorkflowRuntimeContext(deps);
  }

  async start(options: ExpertWorkflowRunOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = this.ctx.createInitialSnapshot(options);
    await this.ctx.store.writeSnapshot(snapshot, { signal: options.abortSignal });
    await this.ctx.writeInitialGraph(snapshot, options.abortSignal);
    await this.ctx.appendEvent(snapshot.runId, "run_started", {
      message: `${this.ctx.definition.title} started.`,
      signal: options.abortSignal,
    });

    const runAbort = this.ctx.registerRunAbortSignal(snapshot.runId, options.abortSignal);
    try {
      return await continueRun(this.ctx, snapshot, {
        ...options,
        abortSignal: runAbort.signal,
      });
    } finally {
      runAbort.dispose();
    }
  }

  async startBackground(options: ExpertWorkflowRunOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = this.ctx.createInitialSnapshot(options);
    await this.ctx.store.writeSnapshot(snapshot, { signal: options.abortSignal });
    await this.ctx.writeInitialGraph(snapshot, options.abortSignal);
    await this.ctx.appendEvent(snapshot.runId, "run_started", {
      message: `${this.ctx.definition.title} started.`,
      signal: options.abortSignal,
    });

    const running = this.ctx.updateSnapshot(snapshot, {
      startedAt: snapshot.startedAt ?? this.ctx.timestamp(),
      status: "running",
    });
    await this.ctx.store.writeSnapshot(running, { signal: options.abortSignal });

    const runAbort = this.ctx.registerRunAbortSignal(snapshot.runId, options.abortSignal);
    void continueRun(this.ctx, running, {
      ...options,
      abortSignal: runAbort.signal,
    })
      .catch(async (error) => {
        if (runAbort.signal.aborted) return;
        await this.ctx.appendEvent(snapshot.runId, "run_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        runAbort.dispose();
      });

    return {
      response: formatExpertWorkflowStatus(running),
      runId: running.runId,
      snapshot: running,
      status: running.status,
      traceId: running.traceId,
    };
  }

  async resume(
    options: ExpertWorkflowLookupOptions & {
      onEvent?: (event: SessionEvent) => void | Promise<void>;
      traceContext?: TraceContext;
    },
  ): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    if (isTerminalStatus(snapshot.status)) {
      return {
        response: formatExpertWorkflowStatus(snapshot),
        runId: snapshot.runId,
        snapshot,
        status: snapshot.status,
        traceId: snapshot.traceId,
      };
    }

    const resumeRepair = reconcileWorkflowSnapshotForResume(snapshot, {
      timestamp: this.ctx.timestamp(),
    });
    const resumed = {
      ...resumeRepair.snapshot,
      status: "running" as const,
      updatedAt: this.ctx.timestamp(),
    };
    await this.ctx.store.writeSnapshot(resumed, { signal: options.abortSignal });
    await this.ctx.appendLifecycleGraphChanges(
      resumed,
      resumeRepair.nodeChanges,
      options.abortSignal,
    );
    if (resumeRepair.changed) {
      await this.ctx.appendEvent(resumed.runId, "graph_updated", {
        message: "Workflow resume repaired stale active work.",
        payload: lifecyclePayload(resumeRepair),
        signal: options.abortSignal,
      });
    }

    const runAbort = this.ctx.registerRunAbortSignal(resumed.runId, options.abortSignal);
    try {
      return await continueRun(this.ctx, resumed, {
        abortSignal: runAbort.signal,
        cwd: resumed.cwd,
        onEvent: options.onEvent,
        sessionId: resumed.sessionId,
        task: resumed.task,
        traceContext: options.traceContext,
      });
    } finally {
      runAbort.dispose();
    }
  }

  async status(options: ExpertWorkflowLookupOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    return {
      reportPath: snapshot.reportPath,
      response: formatExpertWorkflowStatus(snapshot),
      runId: snapshot.runId,
      snapshot,
      status: snapshot.status,
      traceId: snapshot.traceId,
    };
  }

  async retry(options: ExpertWorkflowRetryOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    if (snapshot.status === "completed" || snapshot.status === "cancelled") {
      return {
        response: formatExpertWorkflowStatus(snapshot),
        runId: snapshot.runId,
        snapshot,
        status: snapshot.status,
        traceId: snapshot.traceId,
      };
    }

    const prepared = prepareSnapshotForRetry(this.ctx, snapshot, options);
    await this.ctx.store.writeSnapshot(prepared.snapshot, { signal: options.abortSignal });
    await this.ctx.appendLifecycleGraphChanges(
      prepared.snapshot,
      prepared.nodeChanges,
      options.abortSignal,
    );
    await this.ctx.appendEvent(prepared.snapshot.runId, "workflow_retry_started", {
      message: `${this.ctx.definition.title} retry started.`,
      payload: {
        activityId: options.activityId,
        nodeId: options.nodeId,
        phase: options.phase ?? prepared.snapshot.currentPhase,
        resetNodeIds: prepared.nodeChanges.map((change) => change.nodeId),
      },
      phase: options.phase ?? prepared.snapshot.currentPhase,
      signal: options.abortSignal,
    });

    const runAbort = this.ctx.registerRunAbortSignal(prepared.snapshot.runId, options.abortSignal);
    try {
      return await continueRun(this.ctx, prepared.snapshot, {
        abortSignal: runAbort.signal,
        cwd: prepared.snapshot.cwd,
        onEvent: options.onEvent,
        sessionId: prepared.snapshot.sessionId,
        task: prepared.snapshot.task,
        traceContext: options.traceContext,
      });
    } finally {
      runAbort.dispose();
    }
  }

  async cancel(options: ExpertWorkflowLookupOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    if (isTerminalStatus(snapshot.status)) {
      return {
        response: formatExpertWorkflowStatus(snapshot),
        runId: snapshot.runId,
        snapshot,
        status: snapshot.status,
        traceId: snapshot.traceId,
      };
    }
    const cancelRepair = cancelWorkflowSnapshot(snapshot, {
      timestamp: this.ctx.timestamp(),
    });
    const cancelled = cancelRepair.snapshot;
    await this.ctx.store.writeSnapshot(cancelled, { signal: options.abortSignal });
    await this.ctx.appendLifecycleGraphChanges(
      cancelled,
      cancelRepair.nodeChanges,
      options.abortSignal,
    );
    await this.ctx.appendEvent(cancelled.runId, "run_cancelled", {
      message: `${this.ctx.definition.title} cancelled.`,
      payload: lifecyclePayload(cancelRepair),
      signal: options.abortSignal,
    });
    this.ctx.activeRunAbortControllers.get(snapshot.runId)?.abort(new Error("Workflow cancelled"));
    return {
      response: formatExpertWorkflowStatus(cancelled),
      runId: cancelled.runId,
      snapshot: cancelled,
      status: cancelled.status,
      traceId: cancelled.traceId,
    };
  }

  async list(options: ExpertWorkflowListOptions): Promise<WorkflowRunListItem[]> {
    return await this.ctx.store.listRuns(
      {
        cwd: options.cwd,
        kind: this.ctx.definition.kind,
        limit: options.limit,
      },
      { signal: options.abortSignal },
    );
  }

  async events(options: ExpertWorkflowEventsOptions): Promise<WorkflowEvent[]> {
    const events = await this.ctx.store.readEvents(options.runId, {
      signal: options.abortSignal,
    });
    return options.limit === undefined ? events : events.slice(-Math.max(0, options.limit));
  }
}

export { ExpertWorkflowRuntime as WorkflowRuntime };
