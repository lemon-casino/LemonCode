import {
  WorkflowGraphPlannerResultSchema,
  type WorkflowGraphPlannerResult,
} from "@lcode/contracts";
import { normalizeWorkflowGraphSeedCandidate } from "./graph-seed.js";
import {
  isRecord,
  parsePlannerJson,
  readLooseBoolean,
  readLooseStringArray,
  stringValue,
} from "./json.js";

export function parseWorkflowPlannerResult(
  response: string,
  defaultPhase: string,
): WorkflowGraphPlannerResult {
  const raw = parsePlannerJson(response);
  const direct = WorkflowGraphPlannerResultSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (!isRecord(raw)) {
    throw new Error("Workflow planner did not return JSON graph expansion data");
  }
  const seed = normalizeWorkflowGraphSeedCandidate(raw, defaultPhase);
  const collectionNodeIds =
    readLooseStringArray(raw, [
      "collectionNodeIds",
      "collection_node_ids",
      "collectionUpdates",
      "collection_updates",
    ]) ?? seed?.collections.flatMap((collection) => collection.nodeIds);
  const parsed = WorkflowGraphPlannerResultSchema.safeParse({
    collectionNodeIds,
    edges: seed?.edges ?? [],
    exhausted: readLooseBoolean(raw, ["exhausted"]),
    nodes: seed?.nodes ?? [],
    reasoning: stringValue(raw.reasoning),
  });
  if (parsed.success) return parsed.data;
  throw new Error("Workflow planner did not return JSON graph expansion data");
}
