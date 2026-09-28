import type {
  ExpertWorkflowRunSnapshot,
  WorkflowCriticReopenProposal,
  WorkflowPhaseDefinition,
} from "@lcode/contracts";
import { reopenWorkflowGraphNode } from "../lifecycle.js";
import { phaseNodeId } from "./ids.js";
import { dedupeReopenProposals, parseCriticResult } from "./parsers/critic.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunOptions } from "./types.js";
import { runPhase } from "./phase-runner.js";
import { runScheduledPhase } from "./scheduled-phase.js";

export async function runFinalCriticLoop(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowRunSnapshot> {
  let current = snapshot;
  const execDefinition = ctx.definition.phases.find(
    (phaseDefinition) => phaseDefinition.behavior === "scheduled_graph",
  );
  if (!execDefinition) {
    throw new Error(`${ctx.definition.title} definition is missing a scheduled graph phase`);
  }

  for (let iteration = 1; iteration <= current.strategy.finalCritic.maxIterations; iteration++) {
    await ctx.appendEvent(current.runId, "critic_started", {
      message: `Final critic iteration ${iteration} started.`,
      payload: { iteration },
      phase: definition.phase,
      signal: options.abortSignal,
    });

    const phaseRun = await runPhase(ctx, current, definition, options);
    current = phaseRun.snapshot;
    const critic = parseCriticResult(phaseRun.response);

    if (critic.verdict === "pass") {
      await ctx.appendEvent(current.runId, "critic_passed", {
        message: critic.reasoning || `Final critic iteration ${iteration} passed.`,
        payload: {
          acceptanceGaps: critic.acceptanceGaps,
          iteration,
        },
        phase: definition.phase,
        signal: options.abortSignal,
      });
      return current;
    }

    const reopenProposals = dedupeReopenProposals(critic.reopenProposals);
    await ctx.appendEvent(current.runId, "critic_failed", {
      message: critic.reasoning || `Final critic iteration ${iteration} failed.`,
      payload: {
        acceptanceGaps: critic.acceptanceGaps,
        iteration,
        reopenProposals,
      },
      phase: definition.phase,
      signal: options.abortSignal,
    });

    if (reopenProposals.length === 0) {
      return current;
    }

    const reopenedNodeIds: string[] = [];
    for (const proposal of reopenProposals) {
      const reopen = await tryReopenCriticNode(
        ctx,
        current,
        proposal,
        iteration,
        definition.phase,
        options.abortSignal,
      );
      if (!reopen) continue;
      current = reopen.snapshot;
      reopenedNodeIds.push(proposal.nodeId);
      await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
      await appendGraphReopen(
        ctx,
        current,
        proposal,
        iteration,
        reopen.reopenAttempts,
        definition.phase,
        options.abortSignal,
      );
      await ctx.appendEvent(current.runId, "node_reopened", {
        message: `Node reopened by final critic: ${proposal.nodeId}`,
        nodeId: proposal.nodeId,
        payload: {
          iteration,
          reason: proposal.reason,
          reopenAttempts: reopen.reopenAttempts,
          severity: proposal.severity,
        },
        phase: definition.phase,
        signal: options.abortSignal,
      });
    }

    if (reopenedNodeIds.length === 0) {
      return current;
    }

    const retryReason = `Final critic reopened node(s): ${reopenedNodeIds.join(", ")}`;
    current = resetPhaseForRetry(ctx, current, execDefinition.phase, retryReason);
    current = resetPhaseForRetry(ctx, current, definition.phase, retryReason);
    await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
    await ctx.appendGraphStatus(current, execDefinition.phase, "pending", options.abortSignal);
    await ctx.appendGraphStatus(current, definition.phase, "pending", options.abortSignal);
    current = await runScheduledPhase(ctx, current, execDefinition, options);
  }

  current = ctx.updatePhase(current, definition.phase, {
    completedAt: ctx.timestamp(),
    error: "Final critic iteration limit reached.",
    status: "failed",
  });
  await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
  await ctx.appendGraphStatus(current, definition.phase, "failed", options.abortSignal);
  await ctx.appendEvent(current.runId, "critic_iteration_limit_reached", {
    message: "Final critic iteration limit reached.",
    payload: { maxIterations: current.strategy.finalCritic.maxIterations },
    phase: definition.phase,
    signal: options.abortSignal,
  });
  return current;
}

async function tryReopenCriticNode(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  proposal: WorkflowCriticReopenProposal,
  iteration: number,
  phase: string,
  signal?: AbortSignal,
): Promise<{ reopenAttempts: number; snapshot: ExpertWorkflowRunSnapshot } | null> {
  try {
    const result = reopenWorkflowGraphNode(snapshot, {
      maxReopens: 2,
      nodeId: proposal.nodeId,
      reason: proposal.reason,
      timestamp: ctx.timestamp(),
    });
    return {
      reopenAttempts: result.reopenAttempts,
      snapshot: result.snapshot,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.appendEvent(snapshot.runId, "critic_failed", {
      message: `Critic reopen rejected for ${proposal.nodeId}: ${message}`,
      payload: {
        iteration,
        nodeId: proposal.nodeId,
        reason: proposal.reason,
        rejected: true,
      },
      phase,
      signal,
    });
    return null;
  }
}

function resetPhaseForRetry(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  phase: string,
  reason: string,
): ExpertWorkflowRunSnapshot {
  return {
    ...snapshot,
    currentPhase: phase,
    graph: {
      collections: snapshot.graph.collections,
      edges: snapshot.graph.edges,
      nodes: snapshot.graph.nodes.map((node) =>
        node.id === phaseNodeId(phase) && node.kind === "phase"
          ? {
              ...node,
              error: reason,
              status: "pending" as const,
            }
          : node,
      ),
    },
    phases: snapshot.phases.map((item) =>
      item.phase === phase
        ? {
            error: reason,
            phase,
            status: "pending" as const,
          }
        : item,
    ),
    updatedAt: ctx.timestamp(),
  };
}

async function appendGraphReopen(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  proposal: WorkflowCriticReopenProposal,
  iteration: number,
  reopenAttempts: number,
  phase: string,
  signal?: AbortSignal,
): Promise<void> {
  await ctx.store.appendGraphRecord(
    snapshot.runId,
    {
      nodeId: proposal.nodeId,
      payload: {
        iteration,
        reason: proposal.reason,
        reopenAttempts,
        severity: proposal.severity,
      },
      phase,
      recordType: "op",
      runId: snapshot.runId,
      status: "pending",
      timestamp: ctx.timestamp(),
      type: "reopen_node",
    },
    { signal },
  );
}
