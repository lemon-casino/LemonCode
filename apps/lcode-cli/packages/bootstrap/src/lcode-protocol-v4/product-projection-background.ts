// 后台 work 的生命周期与持久消费代次，不改变 resultPending 的提交边界。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { CanonicalUserIntentFact } from "./event-normalizer.js";
import type {
  ConversationDelta,
  ToolCallRow,
  BackgroundWorkSummary,
} from "@lcode/shared/lcode-protocol-v4";
import {
  parseLCodeBackgroundTaskNotificationText,
  lcodeBackgroundTaskNotificationToolUpdateStatus,
  lcodeBackgroundTaskResultConsumedPayloadSchema,
  resolveLCodeBackgroundTaskControlKind,
} from "@lcode/shared";
import { findToolRow, ms } from "./product-projection-rows.js";
import { buildToolOutput } from "./projection-rows.js";
import { type SessionEvent, SessionEventType } from "@lcode/contracts";

type ApplyBackgroundTaskNotificationHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "toolRowIdByCallId"
>;

type BackgroundTaskResultConsumedHost = Pick<
  ProductProjectionState,
  "snapshot" | "backgroundLifecycleByWorkId" | "consumedBackgroundLifecycles"
>;

export function applyBackgroundTaskNotification(
  host: ApplyBackgroundTaskNotificationHost,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const parsed = parseLCodeBackgroundTaskNotificationText(fact.input);
  if (!parsed) return [];
  const row = findToolRow(host, parsed.toolUseId);
  if (!row) return [];

  const notificationStatus = lcodeBackgroundTaskNotificationToolUpdateStatus(
    parsed.notification.status,
  );
  const status: ToolCallRow["status"] =
    notificationStatus === "failed"
      ? "error"
      : notificationStatus === "stopped"
        ? "cancelled"
        : "success";
  const content =
    parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
  const next: ToolCallRow = {
    ...row,
    status,
    ...(content
      ? {
          output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
        }
      : {}),
    endedAt: ms(fact.event),
  };
  if (status === "error") {
    next.error = {
      code: "fault.runtime.backgroundTaskFailed",
      message: parsed.notification.error ?? content ?? "Background task failed.",
    };
  } else {
    delete next.error;
  }
  return [{ op: "row.upserted", row: next }];
}

export function onBackgroundTaskResultConsumed(
  host: BackgroundTaskResultConsumedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const parsed = lcodeBackgroundTaskResultConsumedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return [];
  const { workId, lifecycleId } = parsed.data;
  host.consumedBackgroundLifecycles.add(lifecycleId);
  // outer-drain 已持久化结果，但 continuation 尚未 TurnStarted；保留待处理条目，
  // 在新轮进入 running 的同一事务再移除，防止中间完成态提前生成 Git 草稿。
  if (parsed.data.delivery === "continuation") return [];
  const currentLifecycle = host.backgroundLifecycleByWorkId.get(workId);
  // 旧结果可以晚于同一 workId 的 resume 消费，不能抹掉新一代 running work。
  if (currentLifecycle && currentLifecycle !== lifecycleId) return [];
  const previous = host.snapshot.backgroundWorks;
  const backgroundWorks = previous.filter((work) => work.workId !== workId);
  return backgroundWorks.length === previous.length
    ? []
    : [{ op: "state.updated", patch: { backgroundWorks } }];
}

export function removeConsumedBackgroundWorks(
  host: BackgroundTaskResultConsumedHost,
): ConversationDelta[] {
  const previous = host.snapshot.backgroundWorks;
  const backgroundWorks = previous.filter((work) => {
    const lifecycleId = host.backgroundLifecycleByWorkId.get(work.workId);
    return !lifecycleId || !host.consumedBackgroundLifecycles.has(lifecycleId);
  });
  return backgroundWorks.length === previous.length
    ? []
    : [{ op: "state.updated", patch: { backgroundWorks } }];
}

// cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
// → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
// taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。
export function onBackgroundTaskLifecycle(
  host: BackgroundTaskResultConsumedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    taskId?: string;
    lifecycleId?: string;
    toolName?: string;
    taskKind?: string;
    command?: string;
    description?: string;
    status?: string;
    cancellable?: boolean;
    blocked?: boolean;
    childSessionId?: string;
  };
  const workId = payload.taskId;
  if (!workId) return [];
  if (payload.lifecycleId) {
    const previousLifecycle = host.backgroundLifecycleByWorkId.get(workId);
    if (
      event.type !== SessionEventType.BackgroundTaskStarted &&
      previousLifecycle &&
      previousLifecycle !== payload.lifecycleId
    )
      return [];
    host.backgroundLifecycleByWorkId.set(workId, payload.lifecycleId);
    // 通知入队可早于终态事件发布；已消费代次的迟到终态不得复活 resultPending。
    if (host.consumedBackgroundLifecycles.has(payload.lifecycleId)) return [];
  }
  const prev = host.snapshot.backgroundWorks;
  const existing = prev.find((work) => work.workId === workId);
  const legacyKind = resolveLCodeBackgroundTaskControlKind(payload);
  // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
  // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
  // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
  // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
  const kind: BackgroundWorkSummary["kind"] =
    payload.taskKind === "subagent"
      ? "subagent"
      : payload.taskKind === "bash"
        ? "bash"
        : payload.taskKind === "workflow"
          ? "workflow"
          : legacyKind === "agent"
            ? "subagent"
            : legacyKind === "bash"
              ? "bash"
              : (existing?.kind ?? "bash");
  // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
  // → summary status（running/resultPending/failed/cancelled）。
  const rawStatus = payload.status ?? "running";
  const status: "running" | "resultPending" | "failed" | "cancelled" =
    rawStatus === "running"
      ? "running"
      : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "completed"
          ? "resultPending"
          : "failed";
  const title =
    payload.description?.trim() ||
    payload.command?.trim() ||
    existing?.title ||
    payload.toolName ||
    workId;
  const next: BackgroundWorkSummary = {
    workId,
    kind,
    title,
    status,
    startedAt:
      event.type === SessionEventType.BackgroundTaskStarted
        ? ms(event)
        : (existing?.startedAt ?? ms(event)),
    ...(status === "running" ? {} : { endedAt: ms(event) }),
    ...(typeof payload.cancellable === "boolean"
      ? { cancellable: payload.cancellable }
      : existing?.cancellable !== undefined
        ? { cancellable: existing.cancellable }
        : {}),
    ...(typeof payload.blocked === "boolean"
      ? { blocked: payload.blocked }
      : existing?.blocked !== undefined
        ? { blocked: existing.blocked }
        : {}),
    anchorRowId: existing?.anchorRowId ?? null,
    ...(payload.childSessionId
      ? { childSessionId: payload.childSessionId }
      : existing?.childSessionId
        ? { childSessionId: existing.childSessionId }
        : {}),
  };
  // 幂等：内容无变化不产 delta。
  if (
    existing &&
    existing.status === next.status &&
    existing.title === next.title &&
    existing.kind === next.kind &&
    existing.cancellable === next.cancellable &&
    existing.blocked === next.blocked &&
    existing.childSessionId === next.childSessionId
  ) {
    return [];
  }
  const backgroundWorks = existing
    ? prev.map((work) => (work.workId === workId ? next : work))
    : [...prev, next];
  return [{ op: "state.updated", patch: { backgroundWorks } }];
}
