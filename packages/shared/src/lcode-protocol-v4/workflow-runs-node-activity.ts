import { workflowNodeActivitySchema, type WorkflowNodeWait } from "./workflow-activity.js";
import type { WorkflowRunNode, WorkflowRunState } from "./workflow-runs.js";

type ActivityFields = Pick<WorkflowRunNode, "activity" | "wait" | "settledAt">;

export function carryNodeActivity(
  eventType: string,
  payload: Record<string, unknown>,
  previous: WorkflowRunNode | undefined,
  occurredAt: number | undefined,
): ActivityFields {
  const born =
    eventType === "node-queued" ||
    eventType === "node-retried" ||
    (eventType === "node-settled" && payload.cached === true);
  const activity = born ? undefined : previous?.activity;
  const settledAt = eventType === "node-settled" ? readTimestamp(occurredAt) : undefined;
  const wait =
    eventType === "node-waiting" ? readWait(payload, previous?.wait, occurredAt) : undefined;
  return {
    ...(activity === undefined ? {} : { activity }),
    ...(wait === undefined ? {} : { wait }),
    ...(settledAt === undefined ? {} : { settledAt }),
  };
}

export function reduceNodeActivity(
  run: WorkflowRunState,
  ref: { siteId: string; ordinal: number },
  attempt: number,
  value: unknown,
): WorkflowRunState {
  if (run.status !== "running" && run.status !== "pending") return run;
  const index = run.nodes.findIndex(
    (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
  );
  if (index < 0) return run;
  const node = run.nodes[index]!;
  // 活动没有生命周期权力；旧尝试和终态后的迟到观察不能把节点重新点亮。
  if ((node.attempt ?? 1) !== attempt || node.phase === "settled" || node.phase === "paused")
    return run;
  const parsed = workflowNodeActivitySchema.safeParse(value);
  if (!parsed.success || parsed.data.observedAt < (node.activity?.observedAt ?? 0)) return run;
  const nodes = [...run.nodes];
  nodes[index] = { ...node, activity: parsed.data };
  return { ...run, nodes };
}

function readWait(
  payload: Record<string, unknown>,
  previous: WorkflowNodeWait | undefined,
  occurredAt: number | undefined,
): WorkflowNodeWait | undefined {
  if (payload.cause !== "slot" && payload.cause !== "backoff") return undefined;
  const since =
    (previous?.cause === payload.cause ? previous.since : undefined) ?? readTimestamp(occurredAt);
  const delayMs = readTimestamp(payload.delayMs);
  const at = readTimestamp(occurredAt);
  const nextRetryAt =
    payload.cause === "backoff" && delayMs !== undefined && at !== undefined
      ? readTimestamp(at + delayMs)
      : undefined;
  const attempt =
    typeof payload.attempt === "number" &&
    Number.isSafeInteger(payload.attempt) &&
    payload.attempt > 0
      ? payload.attempt
      : undefined;
  const reason =
    typeof payload.reason === "string" && payload.reason.length > 0
      ? payload.reason.slice(0, 64)
      : undefined;
  return {
    cause: payload.cause,
    ...(reason === undefined ? {} : { reason }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(since === undefined ? {} : { since }),
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
  };
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
