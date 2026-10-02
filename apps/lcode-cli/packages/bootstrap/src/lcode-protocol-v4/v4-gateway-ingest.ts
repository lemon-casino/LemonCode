import type { SessionEvent, TargetChangedPayload } from "@lcode/contracts";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { SessionEventType } from "@lcode/contracts";
import { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher.js";
import { type V4GatewayState } from "./v4-gateway-state.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-errors.js";
import { ensurePublisher } from "./v4-gateway-publishers.js";
import { fanOutToIndex } from "./v4-gateway-sessions-index.js";
import {
  normalizeRuntimeEventSequence,
  resolveProjectionEventCommit,
  rejectProjectionEventCommit,
} from "./v4-gateway-sequence.js";
import { scheduleFlush } from "./v4-gateway-delivery.js";

const MAX_TELEMETRY_EVENT_IDS = 2_000;

/** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
export function updateSharedContextImport(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "flushStates"
    | "host"
    | "localTtft"
    | "pausedConnections"
    | "publishers"
  >,
  sessionId: string,
  source: ConversationSnapshot["sharedContextImport"],
): void {
  const publisher = gateway.publishers.get(sessionId);
  if (!publisher) return;
  publisher.seedSharedContextImport(source);
  for (const [routeKey, state] of gateway.flushStates) {
    if (state.sessionId === sessionId) scheduleFlush(gateway, routeKey, state, publisher);
  }
}

/** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
export function ingest(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "cuaPermissionNormalizer"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "inbox"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "projectionFaultedSessions"
    | "publishers"
    | "rawSequenceStates"
    | "telemetryEventIds"
    | "telemetryNormalizer"
  >,
  sessionId: string,
  event: SessionEvent,
): void {
  if (gateway.disposed) return;
  const hydrationBuffer = gateway.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) {
    const eventId = String(event.id);
    if (hydrationBuffer.eventIds.has(eventId)) return;
    // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
    hydrationBuffer.eventIds.add(eventId);
    hydrationBuffer.rawEvents.push(event);
  }
  emitLiveTelemetryFact(gateway, sessionId, event);
  for (const normalizedEvent of normalizeRuntimeEventSequence(gateway, sessionId, event)) {
    try {
      gateway.localTtft.event(sessionId, normalizedEvent);
    } catch (error) {
      try {
        gateway.host.onError?.("v4.localTtft.observe", error);
      } catch {
        /* 诊断回调也不能阻断实际内容。 */
      }
    }
    ingestNormalizedEvent(gateway, sessionId, normalizedEvent);
  }
}

export function emitLiveTelemetryFact(
  gateway: Pick<
    V4GatewayState,
    "cuaPermissionNormalizer" | "host" | "publishers" | "telemetryEventIds" | "telemetryNormalizer"
  >,
  sessionId: string,
  event: SessionEvent,
): void {
  const eventId = String(event.id);
  // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
  // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
  // 导致前台 Subagent 的真实轮次事实被静默丢弃。
  const telemetryEventKey = `${sessionId}\0${eventId}`;
  if (gateway.telemetryEventIds.has(telemetryEventKey)) return;
  gateway.telemetryEventIds.add(telemetryEventKey);
  if (gateway.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
    const oldest = gateway.telemetryEventIds.values().next().value;
    if (typeof oldest === "string") gateway.telemetryEventIds.delete(oldest);
  }
  try {
    const config =
      gateway.publishers.get(sessionId)?.getSnapshot().config ??
      gateway.host.getSessionConfigSeed?.(sessionId) ??
      undefined;
    const fact = gateway.telemetryNormalizer.normalize(sessionId, event, {
      memoryEnabled: gateway.host.getSessionMemoryEnabled?.(sessionId),
      modelName: config?.model,
      modelProvider: config?.provider,
    });
    if (fact) {
      gateway.host.emitConversationTelemetryFact?.(fact);
    }
  } catch (error) {
    // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
    gateway.host.onError?.("v4.telemetry.normalize", error);
  }
  try {
    const observation = gateway.cuaPermissionNormalizer.normalize(sessionId, event);
    if (observation) gateway.host.emitCuaPermissionObservation?.(observation);
  } catch (error) {
    // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
    gateway.host.onError?.("v4.cuaPermissionObservation.normalize", error);
  }
}

export function ingestNormalizedEvent(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "inbox"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "projectionFaultedSessions"
    | "publishers"
    | "rawSequenceStates"
  >,
  sessionId: string,
  event: SessionEvent,
): void {
  const publisher = ensurePublisher(gateway, sessionId);
  const promotedQueueRemoval =
    event.type === SessionEventType.TurnSteerDiscarded &&
    (event.payload as { reason?: string }).reason === "promoted";
  const removedQueueItems =
    event.type === SessionEventType.TurnSteerDrained ||
    event.type === SessionEventType.TurnSteerDiscarded
      ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
          (queueItemId) => {
            const item = publisher
              .getSnapshot()
              .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
            return item ? [item] : [];
          },
        )
      : [];
  try {
    publisher.ingest(event);
  } catch (error) {
    const commitError =
      error instanceof ProjectionEventCommitWaitError
        ? error
        : new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply event ${String(event.id)}`,
            { cause: error },
          );
    rejectProjectionEventCommit(gateway, sessionId, String(event.id), commitError);
    if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
    gateway.host.onError?.("v4.projection.payloadTooLarge", error);
    if (!gateway.projectionFaultedSessions.has(sessionId)) {
      gateway.projectionFaultedSessions.add(sessionId);
      void Promise.resolve(
        gateway.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
      ).catch((terminateError) => {
        gateway.host.onError?.("v4.projection.terminate", terminateError);
      });
    }
    return;
  }
  resolveProjectionEventCommit(gateway, sessionId, String(event.id));
  if (
    event.type === SessionEventType.TargetChanged &&
    (event.payload as TargetChangedPayload).target?.status === "complete"
  ) {
    try {
      gateway.host.onTargetCompleted?.(sessionId, event);
    } catch (error) {
      gateway.host.onError?.("v4.projection.targetCompleted", error);
    }
  }
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    gateway.projectionFaultedSessions.delete(sessionId);
  }
  if (event.type === SessionEventType.TurnSteerQueued) {
    const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
    const item = queueItemId
      ? publisher
          .getSnapshot()
          .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
      : undefined;
    if (item) gateway.inbox.pinLiveInput(sessionId, item);
  }
  if (!promotedQueueRemoval) {
    if (removedQueueItems.length > 0) {
      // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
      // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
      // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
      gateway.host.invalidatePersistentCommandFacts?.(sessionId);
    }
    for (const item of removedQueueItems) {
      gateway.inbox.releaseLiveInput({
        sessionId,
        commandId: item.sourceCommandId,
      });
    }
  }
  if (event.type === SessionEventType.SessionInputPromoted) {
    const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
    if (sourceCommandId) {
      // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
      // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
      gateway.host.invalidatePersistentCommandFacts?.(sessionId);
      gateway.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
    }
  }
  // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
  // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
  // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
  if (
    publisher.getDroppedContentStreamEventCount() > 0 &&
    gateway.hydratedSessions.has(sessionId)
  ) {
    gateway.hydratedSessions.delete(sessionId);
    gateway.host.onError?.(
      "v4.assistantConservation",
      new Error(
        `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
      ),
    );
  }
  for (const [routeKey, state] of gateway.flushStates) {
    if (state.sessionId !== sessionId) continue;
    scheduleFlush(gateway, routeKey, state, publisher);
  }
  // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
  fanOutToIndex(gateway, sessionId, event);
}
