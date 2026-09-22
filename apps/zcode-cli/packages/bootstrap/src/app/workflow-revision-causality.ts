import type { CausalityGraph } from "@zcode/dynamic-workflow";

/**
 * The static graph is a conservative upper bound, never an authorization to reuse a result.
 * Bare sequencing is not a dependency; data, control, actor FIFO and loop carry are.
 */
export function invalidatedWorkflowSites(graph: CausalityGraph, siteId: string): string[] {
  const sourceOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const affected = new Set(
    graph.steps.filter((step) => (step.source ?? step.id) === siteId).map((step) => step.id),
  );
  const pending = [...affected];
  const edges = graph.edges.filter((edge) => edge.kind !== "seq");
  while (pending.length > 0) {
    const from = pending.shift()!;
    for (const edge of edges) {
      if (edge.from !== from || affected.has(edge.to)) continue;
      affected.add(edge.to);
      pending.push(edge.to);
    }
  }
  return [...new Set([...affected].map((id) => sourceOf.get(id)).filter((id): id is string => id !== undefined))]
    .sort();
}
