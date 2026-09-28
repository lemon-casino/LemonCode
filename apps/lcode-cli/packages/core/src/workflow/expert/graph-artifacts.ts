import {
  applyWorkflowGraphSeed,
  applyWorkflowNodePromptUpdates,
  type ApplyWorkflowGraphSeedResult,
} from "../lifecycle.js";
import { edgeId, phaseNodeId } from "./ids.js";
import { gateRootSeedNodes, parseWorkflowGraphSeed } from "./parsers/graph-seed.js";
import { parseWorkflowNodePromptUpdateSet } from "./parsers/node-prompts.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunSnapshot, WorkflowPhaseDefinition } from "@lcode/contracts";

export async function seedGraphFromPhaseArtifact(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  response: string,
  signal?: AbortSignal,
): Promise<ExpertWorkflowRunSnapshot> {
  if (!definition.seedGraphFromArtifact) {
    return snapshot;
  }

  const targetPhase = definition.seedGraphFromArtifact.targetPhase;
  const seed = parseWorkflowGraphSeed(response, targetPhase);
  if (!seed || (seed.nodes.length === 0 && seed.collections.length === 0)) {
    return snapshot;
  }

  const normalizedSeed = definition.seedGraphFromArtifact.gateAfterPhase
    ? gateRootSeedNodes(seed, phaseNodeId(definition.seedGraphFromArtifact.gateAfterPhase))
    : seed;
  const applied = applyWorkflowGraphSeed(snapshot, normalizedSeed, {
    phase: targetPhase,
    timestamp: ctx.timestamp(),
  });
  if (!applied.changed) {
    return snapshot;
  }

  await ctx.store.writeSnapshot(applied.snapshot, { signal });
  await appendGraphSeedRecords(ctx, applied.snapshot, applied, definition.phase, signal);
  await ctx.appendEvent(applied.snapshot.runId, "graph_expanded", {
    message: `Workflow graph seeded from ${definition.title}.`,
    payload: {
      collectionIds: applied.addedCollections.map((collection) => collection.collectionId),
      edgeIds: applied.addedEdges.map(edgeId),
      nodeIds: applied.addedNodes.map((node) => node.id),
      sourcePhase: definition.phase,
      targetPhase,
    },
    phase: definition.phase,
    signal,
  });
  return applied.snapshot;
}

export async function updateNodePromptsFromPhaseArtifact(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  response: string,
  signal?: AbortSignal,
): Promise<ExpertWorkflowRunSnapshot> {
  if (!definition.nodePromptsFromArtifact) {
    return snapshot;
  }

  const targetPhase = definition.nodePromptsFromArtifact.targetPhase;
  const updateSet = parseWorkflowNodePromptUpdateSet(response);
  if (!updateSet || updateSet.nodes.length === 0) {
    return snapshot;
  }

  const applied = applyWorkflowNodePromptUpdates(snapshot, updateSet.nodes, {
    phase: targetPhase,
    timestamp: ctx.timestamp(),
  });
  if (!applied.changed) {
    return snapshot;
  }

  await ctx.store.writeSnapshot(applied.snapshot, { signal });
  await ctx.store.appendGraphRecord(
    applied.snapshot.runId,
    {
      nodeIds: applied.updatedNodes.map((node) => node.id),
      payload: {
        sourcePhase: definition.phase,
        targetPhase,
      },
      phase: definition.phase,
      recordType: "op",
      runId: applied.snapshot.runId,
      timestamp: ctx.timestamp(),
      type: "node_prompts_updated",
    },
    { signal },
  );
  await ctx.appendEvent(applied.snapshot.runId, "graph_updated", {
    message: `Workflow node prompts updated from ${definition.title}.`,
    payload: {
      nodeIds: applied.updatedNodes.map((node) => node.id),
      sourcePhase: definition.phase,
      targetPhase,
    },
    phase: definition.phase,
    signal,
  });
  return applied.snapshot;
}

async function appendGraphSeedRecords(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  applied: ApplyWorkflowGraphSeedResult<ExpertWorkflowRunSnapshot>,
  phase: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const node of applied.addedNodes) {
    await ctx.store.appendGraphRecord(
      snapshot.runId,
      {
        node,
        recordType: "node",
        runId: snapshot.runId,
        timestamp: ctx.timestamp(),
      },
      { signal },
    );
  }
  for (const edge of applied.addedEdges) {
    await ctx.store.appendGraphRecord(
      snapshot.runId,
      {
        edge,
        recordType: "edge",
        runId: snapshot.runId,
        timestamp: ctx.timestamp(),
      },
      { signal },
    );
  }
  for (const collection of applied.addedCollections) {
    await ctx.store.appendGraphRecord(
      snapshot.runId,
      {
        collection,
        recordType: "collection",
        runId: snapshot.runId,
        timestamp: ctx.timestamp(),
      },
      { signal },
    );
  }
  await ctx.store.appendGraphRecord(
    snapshot.runId,
    {
      edgeIds: applied.addedEdges.map(edgeId),
      nodeIds: applied.addedNodes.map((node) => node.id),
      payload: {
        collectionIds: applied.addedCollections.map((collection) => collection.collectionId),
        sourcePhase: phase,
      },
      phase,
      recordType: "op",
      runId: snapshot.runId,
      timestamp: ctx.timestamp(),
      type: "graph_seeded",
    },
    { signal },
  );
}
