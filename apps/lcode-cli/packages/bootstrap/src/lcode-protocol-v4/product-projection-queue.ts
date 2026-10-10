// 已接受输入的投递、顺序和暂停事实；不引入第二份队列或 admission。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type {
  SessionEvent,
  TurnSteerQueuedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDiscardedPayload,
  SessionInputPromotedPayload,
} from "@lcode/contracts";
import type { ConversationDelta, QueueItem } from "@lcode/shared/lcode-protocol-v4";
import { ms } from "./product-projection-rows.js";
import { queuePatch } from "./product-projection-session.js";

type TurnSteerQueuedHost = Pick<ProductProjectionState, "snapshot" | "deliveryByPendingInputId">;

type TurnSteerDispatchChangedHost = Pick<ProductProjectionState, "snapshot">;

// ── turn-steer 队列──

export function onTurnSteerQueued(
  host: TurnSteerQueuedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerQueuedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  const existingIndex = host.snapshot.queue.items.findIndex(
    (item) => item.queueItemId === queueItemId,
  );
  const existing = existingIndex >= 0 ? host.snapshot.queue.items[existingIndex] : undefined;
  // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
  // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
  const admittedDelivery: "queue" | "guide" =
    payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
      ? payload.intent.admittedDelivery
      : (payload.delivery ??
        (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
          ? existing.delivery.admitted
          : host.snapshot.config.followupMode === "guide"
            ? "guide"
            : "queue"));
  const requestedDelivery =
    payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
  const fallbackReasonCode =
    payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
  const nextItem: QueueItem = {
    queueItemId,
    kind:
      payload.intent?.kind === "compact" || payload.commandKind === "compact"
        ? ("compact" as const)
        : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
          ? ("sendGoalCommand" as const)
          : (existing?.kind ?? ("sendText" as const)),
    text: payload.input,
    sourceCommandId:
      payload.intent?.sourceCommandId ??
      existing?.sourceCommandId ??
      payload.inputId ??
      payload.pendingInputId,
    clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
    attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
    // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
    // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
    modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
    mode: payload.intent?.mode ?? existing?.mode,
    planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
    sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
    contextCapsuleRefs: payload.intent?.contextCapsuleRefs ?? existing?.contextCapsuleRefs,
    provenance: payload.intent?.provenance ?? existing?.provenance,
    delivery: {
      requested: requestedDelivery,
      admitted: admittedDelivery,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq:
        payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
      queuePosition:
        payload.intent?.queuePosition ??
        existing?.order.queuePosition ??
        Math.max(0, (payload.queueLength ?? 1) - 1),
    },
    steer:
      !payload.intent && !payload.delivery && existing
        ? existing.steer
        : fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : admittedDelivery === "guide"
            ? { state: "steering" }
            : { state: "notRequested" },
    dispatch: { state: "queued" },
    ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
    admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? ms(event),
  };
  // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
  host.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
  // 同 id 重入 = editQueueItem 原地更新（保位）；新 id = 追加。旧逻辑 filter+append
  // 会把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
  const items =
    existingIndex >= 0
      ? host.snapshot.queue.items.map((item, index) => (index === existingIndex ? nextItem : item))
      : [...host.snapshot.queue.items, nextItem];
  return [
    {
      op: "state.updated",
      patch: queuePatch(host, { ...host.snapshot.queue, items }),
    },
  ];
}

export function onTurnSteerDispatchChanged(
  host: TurnSteerDispatchChangedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDispatchChangedPayload;
  if (
    !host.snapshot.queue.items.some((candidate) => candidate.queueItemId === payload.pendingInputId)
  ) {
    return [];
  }
  const dispatch =
    payload.state === "queued"
      ? ({ state: "queued" } as const)
      : ({
          state: payload.state,
          reservationId: payload.reservationId,
        } as const);
  return [
    {
      op: "state.updated",
      patch: queuePatch(host, {
        ...host.snapshot.queue,
        items: host.snapshot.queue.items.map((candidate) =>
          candidate.queueItemId === payload.pendingInputId ? { ...candidate, dispatch } : candidate,
        ),
      }),
    },
  ];
}

export function onTurnSteerDeliveryChanged(
  host: TurnSteerQueuedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDeliveryChangedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  if (!host.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
    return [];
  }
  host.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
  return [
    {
      op: "state.updated",
      patch: queuePatch(host, {
        ...host.snapshot.queue,
        items: host.snapshot.queue.items.map((item) =>
          item.queueItemId === queueItemId
            ? {
                ...item,
                delivery: {
                  requested: payload.requestedDelivery,
                  admitted: payload.admittedDelivery,
                  fallbackReasonCode: payload.fallbackReasonCode,
                },
                steer: {
                  state: "fellBack",
                  reasonCode: payload.fallbackReasonCode,
                },
              }
            : item,
        ),
      }),
    },
  ];
}

export function onTurnSteerDiscarded(
  host: TurnSteerQueuedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDiscardedPayload;
  return removeQueueItems(host, payload.pendingInputIds);
}

export function onSessionInputPromoted(
  host: TurnSteerQueuedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionInputPromotedPayload;
  // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
  // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
  // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
  // 因此它才是可以安全移除 queue 投影的 durable commit signal。
  return removeQueueItems(host, [payload.pendingInputId]);
}

/** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
export function onTurnSteerReordered(
  host: TurnSteerDispatchChangedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { orderedPendingInputIds?: string[] };
  const order = payload.orderedPendingInputIds ?? [];
  const byId = new Map(host.snapshot.queue.items.map((item) => [item.queueItemId, item]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((item): item is (typeof host.snapshot.queue.items)[number] => item !== undefined);
  // 未在 order 里出现的项（防丢）追加保持原相对序。
  const orderedIds = new Set(order);
  const rest = host.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
  const reordered = [...ordered, ...rest];
  const items = reordered.map((item, index) =>
    item.order.queuePosition === index
      ? item
      : { ...item, order: { ...item.order, queuePosition: index } },
  );
  // 顺序无变化则不产 delta（幂等）。
  if (
    items.length === host.snapshot.queue.items.length &&
    items.every((item, index) => item === host.snapshot.queue.items[index])
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: queuePatch(host, { ...host.snapshot.queue, items }),
    },
  ];
}

// setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
// （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。
export function onQueueAutoDrainChanged(
  host: TurnSteerDispatchChangedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { autoDrain?: boolean };
  const autoDrain = payload.autoDrain ?? true;
  if (
    host.snapshot.queue.autoDrain === autoDrain &&
    (autoDrain || host.snapshot.queue.pauseReason === "manual")
  ) {
    return [];
  }
  const queue = { ...host.snapshot.queue, autoDrain };
  if (autoDrain) {
    delete queue.pauseReason;
  } else {
    queue.pauseReason = "manual";
  }
  return [
    {
      op: "state.updated",
      patch: queuePatch(host, queue),
    },
  ];
}

export function removeQueueItems(
  host: TurnSteerQueuedHost,
  ids: readonly string[],
): ConversationDelta[] {
  const idSet = new Set(ids);
  for (const id of ids) host.deliveryByPendingInputId.delete(id);
  const items = host.snapshot.queue.items
    .filter((item) => !idSet.has(item.queueItemId))
    .map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
  if (items.length === host.snapshot.queue.items.length) return [];
  return [
    {
      op: "state.updated",
      patch: queuePatch(host, { ...host.snapshot.queue, items }),
    },
  ];
}
