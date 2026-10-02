import { workflowNodeQueueSchema } from "./workflow-activity.js";
import type { WorkflowRunState } from "./workflow-runs.js";

export function reduceNodeAdmission(
  run: WorkflowRunState,
  ref: { siteId: string; ordinal: number },
  attempt: number,
  payload: Record<string, unknown>,
  occurredAt: number | undefined,
): WorkflowRunState {
  if (run.status !== "running" && run.status !== "pending") return run;
  const index = run.nodes.findIndex(
    (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
  );
  if (index < 0) return run;
  const node = run.nodes[index]!;
  // 准入原因只描述已入队的当前尝试，不具备重新激活已派发或暂停节点的权力。
  if (node.phase !== "queued" || (node.attempt ?? 1) !== attempt) return run;
  if (payload.cause === null) {
    if (payload.blockedBy !== undefined || node.queue === undefined) return run;
    const { queue: _cleared, ...withoutQueue } = node;
    const nodes = [...run.nodes];
    nodes[index] = withoutQueue;
    return { ...run, nodes };
  }
  const parsed = workflowNodeQueueSchema.safeParse({
    cause: payload.cause,
    ...(payload.blockedBy === undefined ? {} : { blockedBy: payload.blockedBy }),
  });
  if (!parsed.success) return run;
  const queue = parsed.data;
  const previousBlocker = node.queue?.blockedBy;
  const blocker = queue.blockedBy;
  const sameCause =
    node.queue?.cause === queue.cause &&
    previousBlocker?.siteId === blocker?.siteId &&
    previousBlocker?.ordinal === blocker?.ordinal &&
    (previousBlocker?.attempt ?? 1) === (blocker?.attempt ?? 1);
  const sourceTime =
    typeof occurredAt === "number" && Number.isSafeInteger(occurredAt) && occurredAt >= 0
      ? occurredAt
      : undefined;
  const since = sameCause ? (node.queue?.since ?? sourceTime) : sourceTime;
  const nodes = [...run.nodes];
  nodes[index] = { ...node, queue: { ...queue, ...(since === undefined ? {} : { since }) } };
  return { ...run, nodes };
}
