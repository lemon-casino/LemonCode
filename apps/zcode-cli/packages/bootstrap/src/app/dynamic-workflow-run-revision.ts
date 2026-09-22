import { createHash } from "node:crypto";
import type {
  DynamicWorkflowAskRevisionRequest,
  DynamicWorkflowAskRevisionResult,
  TraceContext,
} from "@zcode/contracts";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import { buildImportedCache } from "./dynamic-workflow-import.js";
import { readRunLaunch } from "./dynamic-workflow-run-launch-anchor.js";
import { compileOnce, startNewRun, type DynamicWorkflowRunEntryContext } from "./dynamic-workflow-run-submit.js";
import { invalidatedWorkflowSites } from "./workflow-revision-causality.js";
import { verifyWorkflowImageRefs } from "./workflow-image-refs.js";

export function workflowRevisionRunId(request: DynamicWorkflowAskRevisionRequest): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([request.runId, request.siteId, request.ordinal, request.supplement?.trim() ?? "", request.attachments ?? []]))
    .digest("hex")
    .slice(0, 32);
  return `dwfrun-revision-${hash}`;
}

export async function reviseDynamicWorkflowAsk(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowAskRevisionRequest,
): Promise<DynamicWorkflowAskRevisionResult> {
  const { deps, runs } = ctx;
  const predecessor = deps.journal.getRun(request.runId);
  if (predecessor === undefined || predecessor.parentSessionId !== deps.parentSessionId ||
      predecessor.scriptText === undefined) return { ok: false, reason: "not_found" };
  const target = deps.journal.getNode(request.runId, request.siteId, request.ordinal);
  if (target?.kind !== "ask" || (target.status !== "completed" && target.status !== "failed")) {
    return { ok: false, reason: "not_completed" };
  }
  if (predecessor.status === "running" ||
      (runs.get(request.runId)?.terminal === undefined && runs.has(request.runId))) {
    return { ok: false, reason: "still_running" };
  }
  if (!(await verifyWorkflowImageRefs(request.attachments, deps.artifactStore)))
    return { ok: false, reason: "not_ready" };

  const runId = workflowRevisionRunId(request);
  const compiled = compileOnce(predecessor.scriptText);
  const invalidatedSites = invalidatedWorkflowSites(compiled.causality, request.siteId);
  if (!invalidatedSites.includes(request.siteId)) return { ok: false, reason: "not_found" };
  if (runs.has(runId) || deps.journal.getRun(runId) !== undefined) {
    return { ok: true, runId, invalidatedSites };
  }
  const imported = await buildImportedCache(deps, request.runId);
  if (!imported.ok) {
    return { ok: false, reason: imported.reason === "missing_boundaries"
      ? "missing_boundaries" : "still_running" };
  }
  const previousLaunch = readRunLaunch(deps.journal, request.runId);
  const inheritedSelection = previousLaunch?.subagentSelection ??
    (previousLaunch?.subagentModel === undefined
      ? undefined
      : parseModelPickerValue(previousLaunch.subagentModel));
  const inheritedSessionSelection = previousLaunch?.sessionSelection ??
    (previousLaunch?.subagentModel === undefined ? previousLaunch?.subagentSelection : undefined);
  const trace: TraceContext = { traceId: runId as TraceContext["traceId"] };
  startNewRun(ctx, {
    runId,
    scriptText: predecessor.scriptText,
    compiled,
    cwd: predecessor.cwd ?? process.cwd(),
    ...(predecessor.name === undefined ? {} : { name: predecessor.name }),
    ...(predecessor.args === undefined ? {} : { args: predecessor.args }),
    maxConcurrency: predecessor.caps.maxConcurrency,
    parentSessionId: deps.parentSessionId,
    ...(predecessor.toolCallId === undefined ? {} : { toolCallId: predecessor.toolCallId }),
    ...(previousLaunch?.phaseNames === undefined ? {} : { phaseNames: previousLaunch.phaseNames }),
    ...(previousLaunch?.phaseAlongside === undefined
      ? {}
      : { phaseAlongside: previousLaunch.phaseAlongside }),
    ...(inheritedSelection === undefined ? {} : { subagentModel: inheritedSelection }),
    ...(inheritedSessionSelection === undefined ? {} : { sessionModelSelection: inheritedSessionSelection }),
    ...(previousLaunch?.actorModelOverrides === undefined
      ? {}
      : { actorModelOverrides: previousLaunch.actorModelOverrides }),
    ...(previousLaunch?.scriptPath === undefined ? {} : { scriptPath: previousLaunch.scriptPath }),
    askRevisions: [{
      siteId: request.siteId,
      ordinal: request.ordinal,
      ...(request.supplement === undefined ? {} : { supplement: request.supplement.trim() }),
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    }],
    invalidatedSites,
    inheritedTokens: predecessor.spentTokens,
    imported: { cache: imported.cache, resumedFrom: request.runId },
    trace,
  });
  return { ok: true, runId, invalidatedSites };
}
