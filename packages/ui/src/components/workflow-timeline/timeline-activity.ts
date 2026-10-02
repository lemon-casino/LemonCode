import type { WorkflowRunNode, WorkflowRunState } from "@lcode/shared/lcode-protocol-v4";
import { workflowRunNodeIndex } from "@/components/workflow-graph/run-node-index.js";

/** 连接只限定展示时效；不把恢复状态写回 run，也不根据静默时长猜测故障。 */
export interface WorkflowTimelineDisplay {
  syncing?: boolean;
  stale?: boolean;
}

export function workflowProjectionDisplay(state: {
  status: "connecting" | "live" | "error" | "closed";
  syncing?: boolean;
}): WorkflowTimelineDisplay {
  return {
    syncing: state.status === "connecting" || (state.status === "live" && state.syncing === true),
    stale: state.status === "error" || state.status === "closed",
  };
}

export interface WorkflowPillActivity {
  kind:
    | "not-started"
    | "created"
    | "queued"
    | "actor-fifo"
    | "run-capacity"
    | "dispatched"
    | "model"
    | "text"
    | "reasoning"
    | "tool"
    | "unknown"
    | "slot"
    | "backoff"
    | "question"
    | "paused"
    | "ended";
  connection?: "syncing" | "stale";
  observedAt?: number;
  since?: number;
  lastRequestCompletedAt?: number;
  deliveredAt?: number;
  requestsCompleted?: number;
  toolCalls?: number;
  toolName?: string;
  reason?: string;
  retryNumber?: number;
  nextRetryAt?: number;
}

/** 仅父视图共享秒针；等待时长不能依赖静默期间不存在的投影事件刷新。 */
export function workflowActivityNeedsClock(activity: WorkflowPillActivity | undefined): boolean {
  if (activity === undefined || activity.connection !== undefined) return false;
  if (activity.kind === "backoff" && activity.nextRetryAt !== undefined) return true;
  return (
    activity.since !== undefined &&
    (activity.kind === "slot" ||
      activity.kind === "backoff" ||
      activity.kind === "actor-fifo" ||
      activity.kind === "run-capacity" ||
      activity.kind === "question" ||
      activity.kind === "tool")
  );
}

function priority(node: WorkflowRunNode): number {
  if (node.phase === "settled") return 0;
  if (node.phase === "queued") return 1;
  if (node.phase === "dispatched") return 2;
  return 3;
}

/** 同 actor 后续 ask 已入队不等于已执行；同优先级未结算节点保留 FIFO 队首。 */
function currentNode(nodes: readonly WorkflowRunNode[]): WorkflowRunNode | undefined {
  let selected: WorkflowRunNode | undefined;
  for (const node of nodes) {
    if (selected === undefined || priority(node) > priority(selected)) selected = node;
    else if (node.phase === "settled" && selected.phase === "settled") {
      const stamp = node.settledAt ?? node.activity?.observedAt ?? 0;
      const previous = selected.settledAt ?? selected.activity?.observedAt ?? 0;
      if (stamp >= previous) selected = node;
    }
  }
  return selected;
}

function isTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

/** 实时投影与静态工具卡共享相位解释；缺相位/活动不把等待猜成模型执行。 */
export function workflowNodeActivity(
  node:
    | Partial<Pick<WorkflowRunNode, "phase" | "activity" | "toolCalls" | "wait" | "queue">>
    | undefined,
  context: {
    ended?: boolean;
    created?: boolean;
    asking?: boolean;
    deliveredAt?: number;
    display?: WorkflowTimelineDisplay;
  } = {},
): WorkflowPillActivity {
  const source = node?.activity;
  const connection = context.display?.syncing
    ? "syncing"
    : context.display?.stale
      ? "stale"
      : undefined;
  const history = {
    ...(connection === undefined ? {} : { connection }),
    ...(source === undefined
      ? {}
      : {
          observedAt: source.observedAt,
          requestsCompleted: source.requestsCompleted,
          toolCalls: source.toolCalls,
          ...(source.lastRequestCompletedAt === undefined
            ? {}
            : { lastRequestCompletedAt: source.lastRequestCompletedAt }),
        }),
    ...(source === undefined && node?.toolCalls !== undefined ? { toolCalls: node.toolCalls } : {}),
    ...(isTimestamp(context.deliveredAt) ? { deliveredAt: context.deliveredAt } : {}),
  } satisfies Partial<WorkflowPillActivity>;
  if (context.ended || node?.phase === "settled") return { ...history, kind: "ended" };
  if (node?.phase === "paused") return { ...history, kind: "paused" };
  // 恢复中的快照是历史事实；不得继续显示正在输出或让旧等待、重试倒计时流动。
  if (connection !== undefined) return { ...history, kind: "unknown" };
  if (node === undefined) return { ...history, kind: context.created ? "created" : "not-started" };
  if (context.asking) return { ...history, kind: "question" };
  if (node.phase === "queued") {
    return {
      ...history,
      kind: node.queue?.cause ?? "queued",
      ...(node.queue?.since === undefined ? {} : { since: node.queue.since }),
    };
  }
  if (node.phase === "dispatched") return { ...history, kind: "dispatched" };
  if (node.phase === "waiting" && node.wait !== undefined) {
    const wait = node.wait;
    return {
      ...history,
      kind: wait.cause,
      // provider 等待与并行工具可同时存在；保留已观察到的工具名，不覆盖权威 wait。
      ...(source?.kind !== "tool" || source.toolName === undefined
        ? {}
        : { toolName: source.toolName }),
      ...(wait.since === undefined ? {} : { since: wait.since }),
      ...(wait.reason === undefined ? {} : { reason: wait.reason }),
      ...(wait.cause !== "backoff"
        ? {}
        : {
            ...(wait.attempt === undefined || wait.attempt < 2
              ? {}
              : { retryNumber: wait.attempt - 1 }),
            ...(wait.nextRetryAt === undefined ? {} : { nextRetryAt: wait.nextRetryAt }),
          }),
    };
  }
  if (node.phase === "waiting" || node.phase === undefined || source === undefined)
    return { ...history, kind: "unknown" };
  return {
    ...history,
    kind: source.kind,
    since: source.since,
    ...(source.kind !== "tool" || source.toolName === undefined
      ? {}
      : { toolName: source.toolName }),
  };
}

/** 入参已按 site + actorOrdinal + phaseBinder 收窄；活动/计数仍只取当前 ask。 */
export function workflowPillActivity(
  nodes: readonly WorkflowRunNode[],
  run: WorkflowRunState,
  created: boolean,
  asking: boolean,
  display: WorkflowTimelineDisplay,
): WorkflowPillActivity {
  // 多 site 分组不能改写 FIFO；只排列候选，不再为每枚药丸过滤整个窗口或重扫交付前缀。
  const index = workflowRunNodeIndex(run.nodes);
  const node = currentNode(index.inProjectionOrder(nodes));
  return workflowNodeActivity(node, {
    ended: run.status !== "running" && run.status !== "pending",
    created,
    asking,
    deliveredAt: index.deliveredAt(node),
    display,
  });
}

export interface WorkflowActivitySummary {
  groups: { kind: WorkflowPillActivity["kind"]; count: number }[];
  total: number;
  truncated: boolean;
  connection?: WorkflowPillActivity["connection"];
}

/** 主状态面板只采样已有父投影，一位已观察 actor 一票；不把后续 FIFO ask 算成另一个 actor。 */
export function workflowRunActivitySummary(
  run: WorkflowRunState,
  display: WorkflowTimelineDisplay = {},
): WorkflowActivitySummary {
  const actors = new Map(
    run.actors.map((actor) => [`${actor.siteId}@${actor.ordinal}`, [] as WorkflowRunNode[]]),
  );
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = `${node.actorSiteId}@${node.actorOrdinal}`;
    const nodes = actors.get(key);
    if (nodes === undefined) actors.set(key, [node]);
    else nodes.push(node);
  }
  const asking = new Set(
    (run.pendingQuestions ?? []).flatMap((question) =>
      question.actorSiteId === undefined || question.actorOrdinal === undefined
        ? []
        : [`${question.actorSiteId}@${question.actorOrdinal}`],
    ),
  );
  const counts = new Map<WorkflowPillActivity["kind"], number>();
  for (const [key, nodes] of actors) {
    const activity = workflowNodeActivity(currentNode(nodes), {
      ended: run.status !== "running" && run.status !== "pending",
      created: true,
      asking: asking.has(key),
      display,
    });
    counts.set(activity.kind, (counts.get(activity.kind) ?? 0) + 1);
  }
  const connection = display.syncing ? "syncing" : display.stale ? "stale" : undefined;
  return {
    groups: [...counts].map(([kind, count]) => ({ kind, count })),
    total: actors.size,
    truncated: run.truncated === true,
    ...(connection === undefined ? {} : { connection }),
  };
}
