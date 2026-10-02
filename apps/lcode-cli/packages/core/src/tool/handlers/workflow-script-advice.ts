import {
  WORKFLOW_ORCHESTRATION_ADVICE_LIMITS,
  workflowScriptFingerprint,
  type WorkflowOrchestrationAdvice,
} from "@lcode/shared/lcode-protocol-v4";
import type { AnalyzeResult } from "@lcode/dynamic-workflow";
import type { ToolInputResolutionResult } from "../types.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import type { WorkflowScriptLocation } from "./workflow-script-notes.js";

/** Keep the display facts bounded; never partially describe a large candidate's dependencies. */
export function workflowAdviceOfAnalysis(analysis: AnalyzeResult): WorkflowOrchestrationAdvice[] {
  const limits = WORKFLOW_ORCHESTRATION_ADVICE_LIMITS;
  return (analysis.orchestrationAdvice ?? [])
    .filter(
      (item) =>
        item.waitingOn.length <= limits.maxLocations && item.delayed.length <= limits.maxLocations,
    )
    .slice(0, limits.maxItems)
    .map((item) => ({ ...item, message: item.message.slice(0, limits.maxMessageChars) }));
}

/** Model-supplied observations are not authority, including malformed observations. */
export function stripWorkflowAdvice(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  if (!Object.hasOwn(input, "orchestration_advice")) return input;
  const { orchestration_advice: _forged, ...rest } = input as Record<string, unknown>;
  void _forged;
  return rest;
}

/** The raw-input approval channel is forward-compatible; the legacy display kind is frozen. */
export function withWorkflowAdvice(resolved: ToolInputResolutionResult): ToolInputResolutionResult {
  if (!resolved.result) return resolved;
  const input = stripWorkflowAdvice(resolved.input);
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { ...resolved, input };
  const script = (input as Record<string, unknown>).script;
  if (typeof script !== "string") return { ...resolved, input };
  const items = workflowAdviceOfAnalysis(analyzeScript(script));
  if (items.length === 0) return { ...resolved, input };
  return {
    ...resolved,
    input: {
      ...input,
      orchestration_advice: { scriptHash: workflowScriptFingerprint(script), items },
    },
  };
}

/** Tool output and model text use current analysis, never the earlier approval observation. */
export function workflowAdviceOutput(analysis: AnalyzeResult): {
  orchestrationAdvice?: WorkflowOrchestrationAdvice[];
} {
  const orchestrationAdvice = workflowAdviceOfAnalysis(analysis);
  return orchestrationAdvice.length === 0 ? {} : { orchestrationAdvice };
}

export function formatWorkflowAdvice(
  analysis: AnalyzeResult,
  location?: WorkflowScriptLocation,
): string {
  const advice = workflowAdviceOfAnalysis(analysis);
  if (advice.length === 0) return "";
  const describe = (loc: { line: number; column: number }): string =>
    `${location === undefined ? "" : `${location.described}:`}L${loc.line + (location?.lineOffset ?? 0)}:C${loc.column}`;
  return (
    "\n\nNon-blocking orchestration advice (no automatic changes):\n" +
    advice
      .map(
        (item) =>
          `- ${describe(item)} [${item.code}] ${item.message} Waiting on ${item.waitingOn.map(describe).join(", ")}; later calls ${item.delayed.map(describe).join(", ")}.`,
      )
      .join("\n")
  );
}
