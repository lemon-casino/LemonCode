import {
  WorkflowGraphSeedSchema,
  type WorkflowGraphEdge,
  type WorkflowGraphSeed,
} from "@lcode/contracts";
import { edgeId } from "../ids.js";
import {
  isRecord,
  parsePlannerJson,
  readLooseArray,
  readLooseBoolean,
  readLoosePositiveInteger,
  readLooseString,
  readLooseStringArray,
  readLooseValue,
  stringValue,
} from "./json.js";

export function parseWorkflowGraphSeed(
  response: string,
  defaultPhase: string,
): WorkflowGraphSeed | null {
  let raw: unknown;
  try {
    raw = parsePlannerJson(response);
  } catch {
    return null;
  }
  return normalizeWorkflowGraphSeedCandidate(raw, defaultPhase);
}

export function gateRootSeedNodes(seed: WorkflowGraphSeed, gateNodeId: string): WorkflowGraphSeed {
  const incomingNodeIds = new Set(seed.edges.map((edge) => edge.to));
  const rootNodeIds = new Set(
    seed.nodes
      .filter((node) => (node.dependsOn ?? []).length === 0 && !incomingNodeIds.has(node.id))
      .map((node) => node.id),
  );
  if (rootNodeIds.size === 0) return seed;

  const edgeIds = new Set(seed.edges.map(edgeId));
  const edges = [...seed.edges];
  for (const nodeId of rootNodeIds) {
    const edge = { from: gateNodeId, to: nodeId };
    if (edgeIds.has(edgeId(edge))) continue;
    edgeIds.add(edgeId(edge));
    edges.push(edge);
  }

  return {
    ...seed,
    edges,
    nodes: seed.nodes.map((node) =>
      rootNodeIds.has(node.id)
        ? {
            ...node,
            dependsOn: [...new Set([...(node.dependsOn ?? []), gateNodeId])],
          }
        : node,
    ),
  };
}

export function normalizeWorkflowGraphSeedCandidate(
  value: unknown,
  defaultPhase: string,
): WorkflowGraphSeed | null {
  if (Array.isArray(value)) {
    if (value.every(isCollectionLikeSeedRecord)) {
      return normalizeWorkflowGraphSeedCandidate({ collections: value }, defaultPhase);
    }
    if (value.every(isNodeLikeSeedRecord)) {
      return normalizeWorkflowGraphSeedCandidate({ nodes: value }, defaultPhase);
    }
    if (value.every(isEdgeLikeSeedRecord)) {
      return normalizeWorkflowGraphSeedCandidate({ edges: value }, defaultPhase);
    }
  }

  if (!isRecord(value)) return null;
  const nodeCandidates = readLooseArray(value, ["nodes", "newNodes", "new_nodes"]);
  const edgeCandidates = readLooseArray(value, ["edges", "newEdges", "new_edges"]);
  const collectionCandidates =
    readLooseArray(value, ["collections"]) ??
    (isCollectionLikeSeedRecord(value) ? [value] : undefined);
  const nodes = (nodeCandidates ?? [])
    .map((node) => normalizeWorkflowGraphSeedNode(node, defaultPhase))
    .filter((node): node is WorkflowGraphSeed["nodes"][number] => node !== null);
  const edges = (edgeCandidates ?? [])
    .map(normalizeWorkflowGraphSeedEdge)
    .filter((edge): edge is WorkflowGraphEdge => edge !== null);
  const collections = (collectionCandidates ?? [])
    .map((collection) => normalizeWorkflowGraphSeedCollection(collection, defaultPhase))
    .filter(
      (collection): collection is WorkflowGraphSeed["collections"][number] => collection !== null,
    );
  const parsed = WorkflowGraphSeedSchema.safeParse({
    collections,
    edges,
    nodes,
    reasoning: stringValue(value.reasoning),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeWorkflowGraphSeedNode(
  value: unknown,
  defaultPhase: string,
): WorkflowGraphSeed["nodes"][number] | null {
  if (!isRecord(value)) return null;
  const id = readLooseString(value, ["id", "name", "nodeName", "node_name"]);
  if (!id) return null;
  const title = readLooseString(value, ["title", "summary"]) ?? id;
  const dependsOn =
    readLooseStringArray(value, ["dependsOn", "depends_on", "references", "inputs"]) ?? [];
  return {
    collectionId: readLooseString(value, ["collectionId", "collection_id", "collection"]),
    dependsOn,
    description: readLooseString(value, ["description", "goal"]),
    id,
    kind: value.kind === "phase" ? "phase" : "task",
    phase: readLooseString(value, ["phase"]) ?? defaultPhase,
    prompt: readLooseString(value, ["prompt", "instructions"]),
    title,
  };
}

function normalizeWorkflowGraphSeedEdge(value: unknown): WorkflowGraphEdge | null {
  if (!isRecord(value)) return null;
  const from = readLooseString(value, ["from", "source"]);
  const to = readLooseString(value, ["to", "target"]);
  if (!from || !to) return null;
  return { from, to };
}

function normalizeWorkflowGraphSeedCollection(
  value: unknown,
  defaultPhase: string,
): WorkflowGraphSeed["collections"][number] | null {
  if (!isRecord(value)) return null;
  const collectionId = readLooseString(value, [
    "collectionId",
    "collection_id",
    "name",
    "id",
    "collectionsname",
  ]);
  if (!collectionId) return null;
  return {
    collectionId,
    explorable: readLooseBoolean(value, ["explorable"]),
    frontierTarget: readLoosePositiveInteger(value, ["frontierTarget", "frontier_target"]),
    goal: readLooseString(value, ["goal"]),
    metric: readLooseString(value, ["metric"]),
    nodeIds: readLooseStringArray(value, ["nodeIds", "node_ids", "nodeNames", "node_names"]) ?? [],
    phase: readLooseString(value, ["phase"]) ?? defaultPhase,
    title: readLooseString(value, ["title"]) ?? collectionId,
  };
}

function isNodeLikeSeedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === "task" ||
      value.kind === "phase" ||
      typeof readLooseValue(value, ["id", "name", "nodeName", "node_name"]) === "string" ||
      typeof readLooseValue(value, ["description", "goal"]) === "string" ||
      Array.isArray(readLooseValue(value, ["dependsOn", "depends_on", "references", "inputs"])))
  );
}

function isEdgeLikeSeedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof readLooseValue(value, ["from", "source"]) === "string" ||
      typeof readLooseValue(value, ["to", "target"]) === "string")
  );
}

function isCollectionLikeSeedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof readLooseValue(value, ["collectionId", "collection_id", "name", "id"]) === "string" ||
      Array.isArray(readLooseValue(value, ["nodeIds", "node_ids", "nodeNames", "node_names"])) ||
      typeof readLooseValue(value, ["goal"]) === "string" ||
      typeof readLooseValue(value, ["metric"]) === "string" ||
      typeof readLooseValue(value, ["explorable"]) === "boolean")
  );
}
