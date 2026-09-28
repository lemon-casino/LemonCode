import type { WorkflowGraph, WorkflowGraphEdge, WorkflowRunStatus } from "@lcode/contracts";

export function phaseNodeId(phase: string): string {
  return `phase:${phase}`;
}

export function edgeId(edge: WorkflowGraphEdge): string {
  return `${edge.from}->${edge.to}`;
}

export function executableNodeIdsForPhase(graph: WorkflowGraph, phase: string): string[] {
  const taskIds = graph.nodes
    .filter((node) => node.kind === "task" && (node.phase === phase || !node.phase))
    .map((node) => node.id);
  return taskIds.length > 0 ? taskIds : [phaseNodeId(phase)];
}

export function safeArtifactName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "workflow";
}

export function safeRunIdSegment(value: string): string {
  return safeArtifactName(value).replace(/[.]/g, "-");
}

export function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
