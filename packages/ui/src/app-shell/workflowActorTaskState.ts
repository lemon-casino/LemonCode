import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "../components/workflow-graph/phase-name.js";

function keyOf(node: WorkflowRunNode): string {
  return `${node.siteId}@${node.ordinal}`;
}

export const WORKFLOW_ACTOR_SUPPLEMENT_MAX_LENGTH = 32_768;

export function resolveWorkflowActorSupplementChange(previous: string, next: string): string {
  return next.length <= WORKFLOW_ACTOR_SUPPLEMENT_MAX_LENGTH ? next : previous;
}

export function updateWorkflowActorTaskError(
  current: Readonly<Record<string, string>>,
  draftKey: string,
  error: string | undefined,
): Record<string, string> {
  if (current[draftKey] === error) return current;
  if (error !== undefined) return { ...current, [draftKey]: error };

  const next = { ...current };
  delete next[draftKey];
  return next;
}

export function selectWorkflowActorTask(
  nodes: readonly WorkflowRunNode[],
  selectedKey: string | undefined,
  focusPhaseName: string | undefined,
): WorkflowRunNode | undefined {
  return (
    nodes.find((node) => keyOf(node) === selectedKey) ??
    [...nodes].reverse().find((node) => phaseNameMatches(focusPhaseName, node.phaseName)) ??
    nodes.find((node) => node.phase !== "settled") ??
    nodes.at(-1)
  );
}

export function workflowActorTaskActionState(
  run: WorkflowRunState | undefined,
  selected: WorkflowRunNode | undefined,
): { canStop: boolean; canRetry: boolean; canRevise: boolean; waitingForRun: boolean } {
  const live = run?.status === "running" && selected !== undefined && selected.phase !== "settled";
  const completed =
    selected?.phase === "settled" && (selected.outcome === "ok" || selected.outcome === "failed");
  return {
    canStop: live && selected.phase !== "paused",
    canRetry: live,
    canRevise: completed && run?.status !== "running" && run?.status !== "pending",
    waitingForRun: completed && run?.status === "running",
  };
}
