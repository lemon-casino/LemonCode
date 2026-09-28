import { cancelWorkflowSnapshot } from "../lifecycle.js";
import { runFinalCriticLoop } from "./critic-loop.js";
import {
  latestWorkflowActivity,
  workflowFailureFromError,
  workflowRecoveryActions,
} from "./failures.js";
import { formatExpertWorkflowCompletion, formatExpertWorkflowStatus } from "./formatters.js";
import {
  seedGraphFromPhaseArtifact,
  updateNodePromptsFromPhaseArtifact,
} from "./graph-artifacts.js";
import { compactWorkflowPayload, lifecyclePayload } from "./runtime-context.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import { runPhase } from "./phase-runner.js";
import { buildReport } from "./prompts.js";
import { runScheduledPhase } from "./scheduled-phase.js";
import type { ExpertWorkflowCommandResult, ExpertWorkflowRunOptions } from "./types.js";
import type { ExpertWorkflowRunSnapshot, WorkflowPhaseDefinition } from "@lcode/contracts";

export async function continueRun(
  ctx: ExpertWorkflowRuntimeContext,
  initialSnapshot: ExpertWorkflowRunSnapshot,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowCommandResult> {
  let snapshot = ctx.updateSnapshot(initialSnapshot, {
    startedAt: initialSnapshot.startedAt ?? ctx.timestamp(),
    status: "running",
  });

  try {
    for (const phaseId of ctx.definition.phaseOrder) {
      const phaseDefinition = ctx.getPhaseDefinition(phaseId);
      if (phaseDefinition.behavior === "complete") {
        snapshot = await completeRun(ctx, snapshot, phaseDefinition, options.abortSignal);
        break;
      }

      const phase = snapshot.phases.find((item) => item.phase === phaseDefinition.phase);
      if (phase?.status === "completed") continue;
      switch (phaseDefinition.behavior) {
        case "scheduled_graph":
          snapshot = await runScheduledPhase(ctx, snapshot, phaseDefinition, options);
          break;
        case "critic":
          snapshot = await runFinalCriticLoop(ctx, snapshot, phaseDefinition, options);
          break;
        case "agent": {
          const phaseRun = await runPhase(ctx, snapshot, phaseDefinition, options);
          snapshot = phaseRun.snapshot;
          snapshot = await seedGraphFromPhaseArtifact(
            ctx,
            snapshot,
            phaseDefinition,
            phaseRun.response,
            options.abortSignal,
          );
          snapshot = await updateNodePromptsFromPhaseArtifact(
            ctx,
            snapshot,
            phaseDefinition,
            phaseRun.response,
            options.abortSignal,
          );
          break;
        }
      }
    }
    return {
      reportPath: snapshot.reportPath,
      response: formatExpertWorkflowCompletion(snapshot),
      runId: snapshot.runId,
      snapshot,
      status: snapshot.status,
      traceId: snapshot.traceId,
    };
  } catch (error) {
    const latest =
      (await ctx.store.readRun(
        snapshot.runId,
        options.abortSignal?.aborted ? undefined : { signal: options.abortSignal },
      )) ?? snapshot;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (options.abortSignal?.aborted) {
      if (latest.status === "cancelled") {
        return {
          response: formatExpertWorkflowStatus(latest),
          runId: latest.runId,
          snapshot: latest,
          status: latest.status,
          traceId: latest.traceId,
        };
      }
      const cancelRepair = cancelWorkflowSnapshot(latest, {
        reason: errorMessage,
        timestamp: ctx.timestamp(),
      });
      const cancelled = cancelRepair.snapshot;
      await ctx.store.writeSnapshot(cancelled);
      await ctx.appendLifecycleGraphChanges(cancelled, cancelRepair.nodeChanges);
      await ctx.appendEvent(cancelled.runId, "run_cancelled", {
        message: errorMessage,
        payload: lifecyclePayload(cancelRepair),
      });
      return {
        response: formatExpertWorkflowStatus(cancelled),
        runId: cancelled.runId,
        snapshot: cancelled,
        status: cancelled.status,
        traceId: cancelled.traceId,
      };
    }

    const paused = pauseRunForFailure(ctx, latest, error, errorMessage);
    await ctx.store.writeSnapshot(paused, { signal: options.abortSignal });
    await ctx.appendEvent(paused.runId, "workflow_paused", {
      message: errorMessage,
      payload: compactWorkflowPayload({
        failureKind: paused.failure?.kind,
        retryable: paused.failure?.retryable,
      }),
      phase: paused.currentPhase,
      signal: options.abortSignal,
    });
    return {
      response: `${formatExpertWorkflowStatus(paused)}\n\nPaused: ${errorMessage}`,
      runId: paused.runId,
      snapshot: paused,
      status: paused.status,
      traceId: paused.traceId,
    };
  }
}

async function completeRun(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  signal?: AbortSignal,
): Promise<ExpertWorkflowRunSnapshot> {
  const report = buildReport(snapshot);
  const written = await ctx.store.writeReport(snapshot.runId, report, { signal });
  const completedPhase = ctx.updatePhase(snapshot, definition.phase, {
    artifactPath: written.relativePath,
    completedAt: ctx.timestamp(),
    startedAt: ctx.timestamp(),
    status: "completed",
  });
  const completed = ctx.addArtifact(
    ctx.updateSnapshot(completedPhase, {
      completedAt: ctx.timestamp(),
      reportPath: written.relativePath,
      status: "completed",
    }),
    {
      contentType: "text/markdown",
      createdAt: ctx.timestamp(),
      label: "Report",
      path: written.relativePath,
      phase: definition.phase,
    },
  );
  await ctx.store.writeSnapshot(completed, { signal });
  await ctx.appendGraphStatus(completed, definition.phase, "completed", signal);
  await ctx.appendEvent(completed.runId, "run_completed", {
    message: `${ctx.definition.title} completed.`,
    signal,
  });
  return completed;
}

function pauseRunForFailure(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  error: unknown,
  message: string,
): ExpertWorkflowRunSnapshot {
  const activity = latestWorkflowActivity(snapshot);
  const failure = workflowFailureFromError(error, message, activity);
  return ctx.updateSnapshot(snapshot, {
    failure,
    pauseReason: failure.message,
    recoveryActions: workflowRecoveryActions(failure),
    status: "paused",
  });
}
