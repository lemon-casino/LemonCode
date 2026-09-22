import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "../components/workflow-graph/phase-name.js";

function keyOf(node: WorkflowRunNode): string {
  return `${node.siteId}@${node.ordinal}`;
}

export function selectWorkflowActorTask(
  nodes: readonly WorkflowRunNode[],
  selectedKey: string | undefined,
  focusPhaseName: string | undefined,
): WorkflowRunNode | undefined {
  return nodes.find((node) => keyOf(node) === selectedKey) ??
    [...nodes].reverse().find((node) => phaseNameMatches(focusPhaseName, node.phaseName)) ??
    nodes.find((node) => node.phase !== "settled") ?? nodes.at(-1);
}

export function workflowActorTaskActionState(
  run: WorkflowRunState | undefined,
  selected: WorkflowRunNode | undefined,
): { canStop: boolean; canRetry: boolean; canRevise: boolean; waitingForRun: boolean } {
  const live = run?.status === "running" && selected !== undefined && selected.phase !== "settled";
  const completed = selected?.phase === "settled" &&
    (selected.outcome === "ok" || selected.outcome === "failed");
  return {
    canStop: live && selected.phase !== "paused",
    canRetry: live,
    canRevise: completed && run?.status !== "running" && run?.status !== "pending",
    waitingForRun: completed && run?.status === "running",
  };
}
