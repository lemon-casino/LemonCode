import type {
  ScriptWorkflowRunRecord,
  ScriptWorkflowStorePort,
  SessionId,
} from "@lcode/contracts";
import type { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import { stableHash } from "./script-workflow-meta.js";
import { emptyScriptWorkflowStats } from "./script-workflow-format.js";
import { inferScriptWorkflowScope } from "./script-workflow-utils.js";

export async function prepareScriptWorkflowRun(input: {
  args?: unknown;
  document: Awaited<ReturnType<typeof readWorkflowScriptDocument>>;
  parentSessionId: SessionId;
  resumeFromRunId?: string;
  runId?: string;
  store: ScriptWorkflowStorePort;
  workingDirectory: string;
}): Promise<ScriptWorkflowRunRecord> {
  const definition = await input.store.upsertScriptWorkflowDefinition({
    id: `script_${stableHash(`${input.document.path}:${input.document.hash}`).slice(0, 24)}`,
    meta: input.document.meta,
    name: input.document.meta.name,
    scope: inferScriptWorkflowScope(input.document.path, input.workingDirectory),
    scriptHash: input.document.hash,
    scriptPath: input.document.path,
    source: "user",
  });
  if (input.resumeFromRunId) {
    const existing = await input.store.getScriptWorkflowRun(input.resumeFromRunId);
    if (!existing) throw new Error(`Workflow run not found: ${input.resumeFromRunId}`);
    return existing;
  }
  return input.store.createScriptWorkflowRun({
    args: input.args,
    argsHash: input.args === undefined ? undefined : stableHash(input.args),
    cwd: input.workingDirectory,
    definitionId: definition.id,
    id: input.runId ?? `wf_${crypto.randomUUID()}`,
    name: input.document.meta.name,
    parentSessionId: input.parentSessionId,
    scriptHash: input.document.hash,
    scriptPath: input.document.path,
    stats: emptyScriptWorkflowStats(),
  });
}
