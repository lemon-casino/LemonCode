import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

type PhaseEntry = NonNullable<WorkflowRunState["phases"]>[number];

/** 精确名称优先，长名称截断时沿用阶段名的回退规则。 */
export function phaseEntryFor(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): PhaseEntry | undefined {
  const entries = run?.phases;
  if (entries === undefined || name === undefined) return undefined;
  return (
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => phaseNameMatches(name, entry.name))
  );
}

export function isCurrentPhase(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/** may-set 拷贝按原站点观察；一个实例的阶段戳再决定归属哪张阶段卡。 */
export function siteIdsOf(
  steps: readonly WorkflowCausalityGraphData["steps"][number][],
): Set<string> {
  return new Set(steps.map((step) => step.source ?? step.id));
}

/** 运行节点按站点索引一次，每站只迭代自己的候选。 */
export function nodesBySiteOf(
  run: WorkflowRunState | undefined,
): ReadonlyMap<string, WorkflowRunState["nodes"]> {
  const bySite = new Map<string, WorkflowRunState["nodes"]>();
  for (const node of run?.nodes ?? []) {
    let bucket = bySite.get(node.siteId);
    if (bucket === undefined) {
      bucket = [];
      bySite.set(node.siteId, bucket);
    }
    bucket.push(node);
  }
  return bySite;
}

export function observePhase(
  nodesBySite: ReadonlyMap<string, WorkflowRunState["nodes"]>,
  siteIds: ReadonlySet<string>,
  entry: PhaseEntry | undefined,
  belongs: (node: WorkflowRunState["nodes"][number]) => boolean,
): { visited: boolean; rounds: number; settled: number; observed: number; entered: boolean } {
  const result = { entered: false, observed: 0, rounds: 0, settled: 0, visited: false };
  for (const siteId of siteIds) {
    for (const node of nodesBySite.get(siteId) ?? []) {
      if (!belongs(node)) continue;
      result.visited = true;
      result.observed += 1;
      if (node.ordinal > result.rounds) result.rounds = node.ordinal;
      if (node.phase === "settled") result.settled += 1;
    }
  }
  if (entry !== undefined) {
    result.entered = true;
    result.visited = true;
    if (entry.rounds > result.rounds) result.rounds = entry.rounds;
  }
  return result;
}
