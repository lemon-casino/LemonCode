import { type ExpertWorkflowRunSnapshot, type WorkflowPhaseDefinition } from "@lcode/contracts";
import { WorkflowGraphScheduler } from "../scheduler.js";
import { executableNodeIdsForPhase, safeArtifactName } from "./ids.js";
import { parseWorkflowPlannerResult } from "./parsers/planner-result.js";
import { buildScheduledNodePrompt, buildScheduledPhaseSummary } from "./prompts.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunOptions } from "./types.js";

export async function runScheduledPhase(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowRunSnapshot> {
  const active = ctx.updatePhase(snapshot, definition.phase, {
    error: undefined,
    startedAt: ctx.timestamp(),
    status: "active",
  });
  await ctx.store.writeSnapshot(active, { signal: options.abortSignal });
  await ctx.appendEvent(active.runId, "phase_started", {
    message: `${definition.title} started.`,
    phase: definition.phase,
    signal: options.abortSignal,
  });

  const scheduler = new WorkflowGraphScheduler({
    appendEvent: (event, eventOptions) => ctx.store.appendEvent(event, eventOptions),
    appendGraphRecord: (runId, record, graphOptions) =>
      ctx.store.appendGraphRecord(runId, record, graphOptions),
    createActivityId: ctx.createActivityId,
    now: ctx.now,
    onWorkflowEvent: ctx.onWorkflowEvent,
    plannerRunner: {
      run: async (input) => {
        const result = await ctx.agentRunner.run({
          abortSignal: input.abortSignal,
          activityId: input.activityId,
          cwd: input.cwd,
          onChildSessionStarted: input.onChildSessionStarted,
          onEvent: input.onEvent,
          parentSessionId: input.parentSessionId,
          phase: input.phase,
          prompt: input.prompt,
          runId: input.runId,
          task: input.task,
          traceContext: input.traceContext,
          workflowKind: ctx.definition.kind,
        });
        const plannerResult = parseWorkflowPlannerResult(result.response, definition.phase);
        return {
          ...plannerResult,
          model: result.model,
          response: result.response,
          sessionId: result.sessionId,
          traceId: result.traceId,
          turnId: result.turnId,
        };
      },
    },
    runner: {
      run: async (input) =>
        ctx.agentRunner.run({
          abortSignal: input.abortSignal,
          activityId: input.activityId,
          cwd: input.cwd,
          onChildSessionStarted: input.onChildSessionStarted,
          onEvent: input.onEvent,
          parentSessionId: input.parentSessionId,
          phase: input.phase,
          prompt: input.prompt,
          runId: input.runId,
          task: input.task,
          traceContext: input.traceContext,
          workflowKind: ctx.definition.kind,
        }),
    },
    writeArtifact: (runId, relativePath, content, writeOptions) =>
      ctx.store.writeArtifact(runId, relativePath, content, writeOptions),
    writeSnapshot: (nextSnapshot, writeOptions) =>
      ctx.store.writeSnapshot(nextSnapshot, writeOptions),
  });
  const result = await scheduler.run({
    abortSignal: options.abortSignal,
    artifactDirectory: `artifacts/${safeArtifactName(definition.phase)}`,
    buildPrompt: ({ node, snapshot: promptSnapshot }) =>
      buildScheduledNodePrompt(promptSnapshot, definition, node),
    cwd: options.cwd,
    executableNodeIds: executableNodeIdsForPhase(active.graph, definition.phase),
    onEvent: options.onEvent,
    parentSessionId: active.sessionId,
    phase: definition.phase,
    snapshot: active,
    traceContext: options.traceContext,
  });

  if (result.status !== "completed") {
    throw new Error(`Workflow ${definition.phase} scheduler paused: ${result.reason}`);
  }

  const summary = buildScheduledPhaseSummary(result.snapshot, definition.phase);
  const artifact = await ctx.store.writeArtifact(
    result.snapshot.runId,
    definition.artifactPath ?? `artifacts/${definition.phase}.md`,
    summary,
    { signal: options.abortSignal },
  );
  const phaseActivity = result.snapshot.activities
    .filter((activity) => activity.phase === definition.phase && activity.status === "completed")
    .at(-1);
  const completed = ctx.updatePhase(result.snapshot, definition.phase, {
    activityId: phaseActivity?.activityId,
    artifactPath: artifact.relativePath,
    completedAt: ctx.timestamp(),
    sessionId: phaseActivity?.sessionId,
    status: "completed",
    traceId: phaseActivity?.traceId,
    turnId: phaseActivity?.turnId,
  });
  const withArtifact = ctx.addArtifact(completed, {
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
  return withArtifact;
}
