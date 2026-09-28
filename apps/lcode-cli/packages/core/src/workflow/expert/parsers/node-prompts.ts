import {
  WorkflowNodePromptUpdateSchema,
  WorkflowNodePromptUpdateSetSchema,
  type WorkflowNodePromptUpdate,
} from "@lcode/contracts";
import {
  isRecord,
  parsePlannerJson,
  readLooseArray,
  readLooseString,
  readLooseValue,
  stringValue,
} from "./json.js";

export function parseWorkflowNodePromptUpdateSet(
  response: string,
): { nodes: WorkflowNodePromptUpdate[]; reasoning?: string } | null {
  let raw: unknown;
  try {
    raw = parsePlannerJson(response);
  } catch {
    return null;
  }
  return normalizeWorkflowNodePromptUpdateSetCandidate(raw);
}

function normalizeWorkflowNodePromptUpdateSetCandidate(
  value: unknown,
): { nodes: WorkflowNodePromptUpdate[]; reasoning?: string } | null {
  if (Array.isArray(value)) {
    return normalizeWorkflowNodePromptUpdateSetCandidate({ nodes: value });
  }

  if (!isRecord(value)) return null;
  const direct = WorkflowNodePromptUpdateSetSchema.safeParse(value);
  if (direct.success && direct.data.nodes.length > 0) return direct.data;

  const nodeCandidates = readLooseArray(value, [
    "nodes",
    "nodePrompts",
    "node_prompts",
    "nodeInstructions",
    "node_instructions",
  ]);
  const keyedCandidates = normalizeWorkflowNodePromptUpdateMap(
    readLooseValue(value, [
      "nodePrompts",
      "node_prompts",
      "nodeInstructions",
      "node_instructions",
      "prompts",
    ]),
  );
  const nodes = [...(nodeCandidates ?? []), ...keyedCandidates]
    .map(normalizeWorkflowNodePromptUpdate)
    .filter((node): node is WorkflowNodePromptUpdate => node !== null);
  const parsed = WorkflowNodePromptUpdateSetSchema.safeParse({
    nodes,
    reasoning: stringValue(value.reasoning),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeWorkflowNodePromptUpdateMap(value: unknown): unknown[] {
  if (!isRecord(value) || Array.isArray(value)) return [];
  return Object.entries(value).map(([id, entry]) =>
    typeof entry === "string"
      ? {
          id,
          prompt: entry,
        }
      : isRecord(entry)
        ? {
            id,
            ...entry,
          }
        : {
            id,
          },
  );
}

function normalizeWorkflowNodePromptUpdate(value: unknown): WorkflowNodePromptUpdate | null {
  if (!isRecord(value)) return null;
  const id = readLooseString(value, ["id", "name", "nodeId", "node_id", "nodeName", "node_name"]);
  if (!id) return null;
  const prompt = readLooseString(value, [
    "prompt",
    "instructions",
    "instruction",
    "rules",
    "metaPrompt",
    "meta_prompt",
    "nodePrompt",
    "node_prompt",
  ]);
  const description = readLooseString(value, ["description", "objective", "goal", "summary"]);
  const title = readLooseString(value, ["title"]);
  const parsed = WorkflowNodePromptUpdateSchema.safeParse({
    description,
    id,
    prompt,
    title,
  });
  return parsed.success ? parsed.data : null;
}
