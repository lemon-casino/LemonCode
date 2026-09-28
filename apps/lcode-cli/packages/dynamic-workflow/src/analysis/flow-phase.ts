import { UNPHASED_ID } from "./constants.js";
import type { OrderTrace } from "./causality-order.js";
import { FLOW_ABORT, FLOW_ENTRY, FLOW_SINK, type FlowEdge, type FlowNode, type FlowPhase } from "./flow-graph.js";

/**
 * The phase quotient of the control-flow graph — the control-flow counterpart of
 * phase-graph.ts (which quotients the CAUSALITY graph). Same vocabulary, same all-or-nothing
 * contract, different question: this one says where execution can go between phases.
 *
 * `alongside` is folded here too, but it is not an edge and so not part of the quotient:
 * it is the union of the mark nodes' own `alongside` lists, because a phase entered twice
 * with different strands running is entered alongside both.
 */

/** Phases some node carries, in first-reach order, {@link UNPHASED_ID} first when present. */
export function collectFlowPhases(trace: OrderTrace, nodes: readonly FlowNode[]): FlowPhase[] {
  const present = new Set(nodes.map((node) => node.phase));
  const rank = new Map<string, number>(trace.phases.map((phase, index) => [phase.id, index + 1]));
  rank.set(UNPHASED_ID, 0);
  const at = (id: string): number => rank.get(id) ?? rank.size;
  const running = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.alongside === undefined) continue;
    const into = running.get(node.phase) ?? new Set<string>();
    for (const id of node.alongside) if (id !== node.phase) into.add(id);
    running.set(node.phase, into);
  }
  const alongsideOf = (id: string): { alongside?: string[] } => {
    const ids = [...(running.get(id) ?? [])].sort((a, b) => at(a) - at(b));
    return ids.length === 0 ? {} : { alongside: ids };
  };
  const out: FlowPhase[] = [];
  if (present.has(UNPHASED_ID)) out.push({ id: UNPHASED_ID, ...alongsideOf(UNPHASED_ID) });
  for (const phase of trace.phases) {
    if (present.has(phase.id)) {
      out.push({ id: phase.id, loc: phase.loc, name: phase.name, ...alongsideOf(phase.id) });
    }
  }
  return out;
}

/**
 * Each occurrence edge projected onto the phases of its endpoints. Same-phase edges dissolve
 * unless they are `loop` back edges (a loop living inside one phase is a self-loop);
 * terminals project to themselves. Kinds are kept apart — the renderer merges arrows, the
 * model does not. No transitive reduction: a CFG never is.
 */
export function quotientFlow(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  phases: readonly FlowPhase[],
): FlowEdge[] {
  const phaseOf = new Map<string, string>(nodes.map((node) => [node.id, node.phase]));
  const rank = new Map<string, number>(phases.map((phase, index) => [phase.id, index]));
  rank.set(FLOW_ENTRY, -1);
  rank.set(FLOW_SINK, phases.length);
  rank.set(FLOW_ABORT, phases.length + 1);
  const at = (id: string): number => rank.get(id) ?? phases.length + 2;
  const seen = new Set<string>();
  const out: FlowEdge[] = [];
  for (const edge of edges) {
    const from = phaseOf.get(edge.from) ?? edge.from;
    const to = phaseOf.get(edge.to) ?? edge.to;
    if (from === to && edge.kind !== "loop") continue;
    const key = `${from}|${to}|${edge.kind}|${edge.via ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, kind: edge.kind, to, ...(edge.via === undefined ? {} : { via: edge.via }) });
  }
  out.sort(
    (a, b) =>
      at(a.from) - at(b.from) ||
      at(a.to) - at(b.to) ||
      a.kind.localeCompare(b.kind) ||
      (a.via ?? "").localeCompare(b.via ?? ""),
  );
  return out;
}
