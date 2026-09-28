import type {
  ScriptWorkflowActivityRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStats,
  WorkflowScriptMeta,
} from "@lcode/contracts";

export function emptyScriptWorkflowStats(): ScriptWorkflowRunStats {
  return {
    agentCalls: 0,
    cachedAgentCalls: 0,
    failedAgentCalls: 0,
    toolCalls: 0,
    tokens: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
  };
}

export function mergeScriptWorkflowStats(
  left: ScriptWorkflowRunStats,
  right: ScriptWorkflowRunStats,
): ScriptWorkflowRunStats {
  return {
    agentCalls: left.agentCalls + right.agentCalls,
    cachedAgentCalls: left.cachedAgentCalls + right.cachedAgentCalls,
    failedAgentCalls: left.failedAgentCalls + right.failedAgentCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    tokens: {
      cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      reasoning: left.tokens.reasoning + right.tokens.reasoning,
      total: left.tokens.total + right.tokens.total,
    },
  };
}

export function formatScriptWorkflowValidation(input: {
  meta: WorkflowScriptMeta;
  scriptHash: string;
  scriptPath: string;
}): string {
  const phases =
    input.meta.phases.length === 0
      ? "none"
      : input.meta.phases.map((phase) => phase.title).join(", ");
  return [
    `Workflow script is valid: ${input.meta.name}`,
    `Description: ${input.meta.description}`,
    `Script: ${input.scriptPath}`,
    `Hash: ${input.scriptHash.slice(0, 12)}`,
    `Phases: ${phases}`,
  ].join("\n");
}

export function formatScriptWorkflowRun(input: {
  activities: ScriptWorkflowActivityRecord[];
  run: ScriptWorkflowRunRecord;
}): string {
  const { run } = input;
  const lines = [
    `workflow ${run.status} · ${run.name}`,
    `runId: ${run.id}`,
    `script: ${run.scriptPath ?? "(inline)"}`,
    formatStats(run.stats ?? emptyScriptWorkflowStats()),
  ];
  const tree = formatActivities(input.activities);
  if (tree.length > 0) lines.push("", tree);
  if (run.failure) lines.push("", `failure: ${formatUnknown(run.failure)}`);
  return lines.join("\n");
}

export function formatScriptWorkflowList(runs: ScriptWorkflowRunRecord[]): string {
  if (runs.length === 0) return "No workflow runs found.";
  return [
    "Workflow runs:",
    ...runs.map((run) => {
      const stats = run.stats ?? emptyScriptWorkflowStats();
      return [
        `- ${run.id}`,
        `${run.status}`,
        run.name,
        `${stats.agentCalls} agents`,
        `${stats.toolCalls} tools`,
      ].join(" · ");
    }),
  ].join("\n");
}

function formatActivities(activities: ScriptWorkflowActivityRecord[]): string {
  if (activities.length === 0) return "";
  return [
    "Activities:",
    ...activities.map((activity) => {
      const label = activity.label ?? activity.phase ?? activity.type;
      const session = activity.childSessionId ? ` · ${activity.childSessionId}` : "";
      return `- ${activity.status} · ${label}${session}`;
    }),
  ].join("\n");
}

function formatStats(stats: ScriptWorkflowRunStats): string {
  return [
    `agents: ${stats.agentCalls}`,
    `cached: ${stats.cachedAgentCalls}`,
    `failed: ${stats.failedAgentCalls}`,
    `tools: ${stats.toolCalls}`,
    `tokens: ${stats.tokens.total}`,
  ].join(" · ");
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
