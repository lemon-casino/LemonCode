import { createChildTraceContext, type WorkflowPhaseDefinition } from "@lcode/contracts";
import { phaseNodeId } from "./ids.js";
import { buildPhasePrompt } from "./prompts.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertPhaseRunResult, ExpertWorkflowRunOptions } from "./types.js";
import type { ExpertWorkflowRunSnapshot } from "@lcode/contracts";

export async function runPhase(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertPhaseRunResult> {
  const activityId = ctx.createActivityId();
  const inputArtifactPaths = snapshot.artifacts.map((artifact) => artifact.path);
  const phaseTraceContext = options.traceContext
    ? createChildTraceContext(options.traceContext, {
        attributes: {
          workflowActivityId: activityId,
          workflowKind: ctx.definition.kind,
          workflowPhase: definition.phase,
          workflowRunId: snapshot.runId,
        },
        sessionId: options.traceContext.sessionId,
      })
    : undefined;
  const active = ctx.updatePhase(snapshot, definition.phase, {
    activityId,
    error: undefined,
    startedAt: ctx.timestamp(),
    status: "active",
    traceId: phaseTraceContext?.traceId,
  });
  const activeWithActivity = ctx.upsertActivity(active, {
    activityId,
    inputArtifactPaths,
    kind: "agent_session",
    nodeId: phaseNodeId(definition.phase),
    outputArtifactPaths: [],
    parentSessionId: active.sessionId,
    phase: definition.phase,
    startedAt: ctx.timestamp(),
    status: "active",
    traceId: phaseTraceContext?.traceId,
  });
  await ctx.store.writeSnapshot(activeWithActivity, { signal: options.abortSignal });
  await ctx.appendGraphStatus(active, definition.phase, "active", options.abortSignal);
  await ctx.appendEvent(active.runId, "phase_started", {
    message: `${definition.title} started.`,
    phase: definition.phase,
    signal: options.abortSignal,
  });
  let runningSnapshot = activeWithActivity;

  try {
    const result = await ctx.agentRunner.run({
      abortSignal: options.abortSignal,
      activityId,
      cwd: options.cwd,
      onChildSessionStarted: async (event) => {
        const currentActivity = runningSnapshot.activities.find(
          (activity) => activity.activityId === activityId,
        );
        if (!currentActivity || currentActivity.status !== "active") return;
        runningSnapshot = ctx.upsertActivity(
          ctx.updatePhase(runningSnapshot, definition.phase, {
            sessionId: event.sessionId,
            traceId: event.traceId ?? currentActivity.traceId,
            turnId: event.turnId ?? currentActivity.turnId,
          }),
          {
            ...currentActivity,
            ...(event.model ? { model: event.model } : {}),
            sessionId: event.sessionId,
            traceId: event.traceId ?? currentActivity.traceId,
            turnId: event.turnId ?? currentActivity.turnId,
          },
        );
        await ctx.store.writeSnapshot(runningSnapshot, { signal: options.abortSignal });
        await ctx.appendEvent(runningSnapshot.runId, "workflow_session_linked", {
          message: `Workflow session linked: ${event.sessionId}`,
          nodeId: phaseNodeId(definition.phase),
          payload: {
            activityId,
            ...(event.model ? { model: event.model } : {}),
            sessionId: event.sessionId,
            ...(event.traceId ? { traceId: event.traceId } : {}),
            ...(event.turnId ? { turnId: event.turnId } : {}),
          },
          phase: definition.phase,
          signal: options.abortSignal,
        });
      },
      onEvent: options.onEvent,
      parentSessionId: active.sessionId,
      phase: definition.phase,
      prompt: buildPhasePrompt(runningSnapshot, definition),
      runId: active.runId,
      task: active.task,
      traceContext: phaseTraceContext,
      workflowKind: ctx.definition.kind,
    });
    const artifactPath = definition.artifactPath ?? `artifacts/${definition.phase}.md`;
    const artifact = await ctx.store.writeArtifact(active.runId, artifactPath, result.response, {
      signal: options.abortSignal,
    });
    const completed = ctx.updatePhase(runningSnapshot, definition.phase, {
      activityId,
      artifactPath: artifact.relativePath,
      completedAt: ctx.timestamp(),
      sessionId: result.sessionId,
      status: "completed",
      traceId: result.traceId ?? phaseTraceContext?.traceId,
      turnId: result.turnId,
    });
    const completedWithActivity = ctx.upsertActivity(completed, {
      activityId,
      artifactPath: artifact.relativePath,
      completedAt: ctx.timestamp(),
      inputArtifactPaths,
      kind: "agent_session",
      ...(result.model ? { model: result.model } : {}),
      nodeId: phaseNodeId(definition.phase),
      outputArtifactPaths: [artifact.relativePath],
      parentSessionId: active.sessionId,
      phase: definition.phase,
      sessionId: result.sessionId,
      startedAt:
        runningSnapshot.activities.find((activity) => activity.activityId === activityId)
          ?.startedAt ?? ctx.timestamp(),
      status: "completed",
      traceId: result.traceId ?? phaseTraceContext?.traceId,
      turnId: result.turnId,
    });
    const withArtifact = ctx.addArtifact(completedWithActivity, {
      contentType: "text/markdown",
      createdAt: ctx.timestamp(),
      label: definition.title,
      path: artifact.relativePath,
      phase: definition.phase,
    });
    await ctx.store.writeSnapshot(withArtifact, { signal: options.abortSignal });
    await ctx.appendGraphStatus(withArtifact, definition.phase, "completed", options.abortSignal);
    await ctx.appendEvent(withArtifact.runId, "artifact_written", {
      message: `Artifact written: ${artifact.relativePath}`,
      phase: definition.phase,
      signal: options.abortSignal,
    });
    await ctx.appendEvent(withArtifact.runId, "phase_completed", {
      message: `${definition.title} completed.`,
      phase: definition.phase,
      signal: options.abortSignal,
    });
    return { response: result.response, snapshot: withArtifact };
  } catch (error) {
    if (options.abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const currentActivity = runningSnapshot.activities.find(
      (activity) => activity.activityId === activityId,
    );
    const failed = ctx.updatePhase(runningSnapshot, definition.phase, {
      activityId,
      completedAt: ctx.timestamp(),
      error: errorMessage,
      status: "failed",
    });
    const failedWithActivity = ctx.upsertActivity(failed, {
      activityId,
      completedAt: ctx.timestamp(),
      error: errorMessage,
      inputArtifactPaths,
      kind: "agent_session",
      ...(currentActivity?.model ? { model: currentActivity.model } : {}),
      nodeId: phaseNodeId(definition.phase),
      outputArtifactPaths: [],
      parentSessionId: active.sessionId,
      phase: definition.phase,
      ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
      startedAt: currentActivity?.startedAt ?? ctx.timestamp(),
      status: "failed",
      traceId: currentActivity?.traceId ?? phaseTraceContext?.traceId,
      ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
    });
    await ctx.store.writeSnapshot(failedWithActivity, { signal: options.abortSignal });
    await ctx.appendGraphStatus(
      failedWithActivity,
      definition.phase,
      "failed",
      options.abortSignal,
    );
    await ctx.appendEvent(failedWithActivity.runId, "phase_failed", {
      message: errorMessage,
      phase: definition.phase,
      signal: options.abortSignal,
    });
    throw error;
  }
}
