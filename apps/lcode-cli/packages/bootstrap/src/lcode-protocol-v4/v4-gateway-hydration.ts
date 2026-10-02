import type { MessageWithParts, SessionEvent } from "@lcode/contracts";
import type { LCodeWorkspaceRef } from "@lcode/shared";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import { type PersistedEventsLoadResult } from "./v4-gateway-contract.js";
import {
  type HydrationBuffer,
  type RawSequenceState,
  type V4GatewayState,
} from "./v4-gateway-state.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-errors.js";
import {
  ensurePublisher,
  seedPublisherConfig,
  seedPublisherUsage,
} from "./v4-gateway-publishers.js";

import { publishCurrentSummaryToIndex } from "./v4-gateway-sessions-index.js";
import {
  normalizeRuntimeEventSequence,
  resolveProjectionEventCommit,
  rejectProjectionEventCommit,
  rejectProjectionEventWaiters,
} from "./v4-gateway-sequence.js";
import { scheduleFlush, emitReservation } from "./v4-gateway-delivery.js";

/**
 * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
 * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
 */
export function ensureColdReadyPublisher(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  sessionId: string,
  resumeThoughtLevel?: string,
  workspace?: LCodeWorkspaceRef,
): Promise<ConversationTopicPublisher> {
  const existingFlight = gateway.readyFlights.get(sessionId);
  if (existingFlight) return existingFlight;
  // 先登记同一个 READY，再开始所有耗时工作。
  const operation = Promise.resolve().then(async () => {
    const persistedMessages = await gateway.coldResume.ensureResumed(
      sessionId,
      resumeThoughtLevel,
      workspace,
    );
    return hydratePublisher(gateway, sessionId, persistedMessages);
  });
  gateway.readyFlights.set(sessionId, operation);
  // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
  const clear = () => {
    if (gateway.readyFlights.get(sessionId) === operation) gateway.readyFlights.delete(sessionId);
  };
  void operation.then(clear, clear);
  return operation;
}

/**
 * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
 * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
 */
export function hydratePublisher(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
  >,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existing = gateway.publishers.get(sessionId);
  // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
  if (existing && gateway.hydratedSessions.has(sessionId)) return Promise.resolve(existing);

  const inFlight = gateway.hydrationInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const buffer: HydrationBuffer = {
    cancelled: false,
    eventIds: new Set<string>(),
    rawEvents: [],
  };
  gateway.hydrationBuffers.set(sessionId, buffer);
  const hydration = performHydration(
    gateway,
    sessionId,
    buffer,
    persistedMessages,
    forceRebuild,
  ).finally(() => {
    if (gateway.hydrationBuffers.get(sessionId) === buffer) {
      gateway.hydrationBuffers.delete(sessionId);
    }
    if (gateway.hydrationInFlight.get(sessionId) === hydration) {
      gateway.hydrationInFlight.delete(sessionId);
    }
  });
  gateway.hydrationInFlight.set(sessionId, hydration);
  return hydration;
}

export async function performHydration(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
  >,
  sessionId: string,
  buffer: HydrationBuffer,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existingAtStart = gateway.publishers.get(sessionId);
  const liveSessionAtStart = gateway.host.sessionExists(sessionId);
  const hydrationStartedAt = performance.now();
  gateway.host.onDebug?.(
    `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
      `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
      `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
  );
  const loaded: PersistedEventsLoadResult = gateway.host.loadPersistedEvents
    ? await gateway.host.loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
        gateway.host.onError?.("v4.hydrate", error, {
          durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
          existingPublisherAtStart: existingAtStart !== undefined,
          liveSessionAtStart,
          phase: "loadPersistedEvents",
          persistedMessages: persistedMessages?.length ?? 0,
          sessionId,
        });
        return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
      })
    : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };

  gateway.host.onDebug?.(
    `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
      `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
      `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
  );

  if (gateway.disposed || buffer.cancelled) {
    throw new Error(`v4 hydration cancelled for session ${sessionId}`);
  }

  // assistant 守恒：拒收过正文流的 publisher 不可信——它建立于
  // TurnStarted 之后，缺段无法用 append-only 重放补进中间位置，只能整体重建。
  const latestPublisher = gateway.publishers.get(sessionId);
  const existingDroppedContent =
    latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
  // 事件日志完整（synthesized=false）且已有健康 live publisher（流式）→ 保留，不重放。
  if (
    existingAtStart &&
    latestPublisher === existingAtStart &&
    !loaded.synthesized &&
    !forceRebuild &&
    !existingDroppedContent
  ) {
    // 创建时种子可能落空（record 尚未入册），首次订阅补一次（幂等、事件优先）。
    gateway.hydrationBuffers.delete(sessionId);
    seedPublisherConfig(gateway, sessionId, latestPublisher);
    if (loaded.sharedContextImport) {
      latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    await seedPublisherUsage(
      gateway,
      sessionId,
      latestPublisher,
      persistedMessages,
      loaded.usageSeed,
    );
    gateway.hydratedSessions.add(sessionId);
    publishCurrentSummaryToIndex(gateway, sessionId);
    return latestPublisher;
  }

  // 只记住 await 之前的 existing 引用是不够的：load 等待期间 raw event
  // 会继续推进这个 publisher，synthesized 返回后却把它整体删除，queue/stream 随之
  // 消失。重建以 sourceEventSeq 为 raw snapshot 边界，并把等待窗口内事件补回。
  const publisher = latestPublisher ?? existingAtStart ?? ensurePublisher(gateway, sessionId);
  rejectProjectionEventWaiters(
    gateway,
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.rehydrated",
      `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
    ),
  );
  publisher.rehydrate(loaded.events, {
    // 恢复时 transcript/event store 可能仍含运行期已拒绝的超大正文。不能让同一事实
    // 在 CLI 重启后再次把 subscribe 卡死；跳过该不可传输 projection event，继续归约
    // 后续持久 TurnError/TurnComplete，使冷快照停在最后一个可恢复边界。
    onPayloadTooLarge: (error) =>
      gateway.host.onError?.("v4.hydrate.payloadTooLarge", error, {
        phase: "publisher.rehydrate",
        sessionId,
      }),
  });
  if (loaded.sharedContextImport) {
    publisher.seedSharedContextImport(loaded.sharedContextImport);
  }
  if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
  // 同次恢复的种子先应用，再补 live buffer；较新的使用量和选模事件始终获胜。
  if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
  const sourceEventSeq = Math.max(
    0,
    loaded.sourceEventSeq ??
      (loaded.synthesized
        ? 0
        : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
  );
  const previousSequenceState = gateway.rawSequenceStates.get(sessionId);
  const sequenceState: RawSequenceState = {
    sourceEventSeq,
    offset: publisher.getSnapshot().seq - sourceEventSeq,
    lastTransportSeq: publisher.getSnapshot().seq,
    seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
    appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
    failedEventById: new Map(previousSequenceState?.failedEventById),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  gateway.rawSequenceStates.set(sessionId, sequenceState);
  // 持久读取的 sourceEventSeq 是 load 开始时的水位；hydration buffer
  // 只能记录 load 开始后的事件。若 seq=N 已在 buffer 创建前进入 live publisher，而
  // load 只读到 N-1 时，rehydrate 后不能仅重放 N+1：raw reorder 会永久等待已经被
  // 丢掉的 N，连带让 running Agent 控制行消失。保留与 publisher 相同大小的 raw tail，
  // 与 await 窗口 buffer 合并后从持久边界连续重放。
  const replayByEventId = new Map<string, SessionEvent>();
  for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  for (const rawEvent of buffer.rawEvents) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  const replayEvents = [...replayByEventId.values()].sort((left, right) => {
    if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
      return left.sequenceNumber - right.sequenceNumber;
    }
    if (left.sequenceNumber > 0) return -1;
    if (right.sequenceNumber > 0) return 1;
    return 0;
  });
  for (const rawEvent of replayEvents) {
    for (const normalized of normalizeRuntimeEventSequence(gateway, sessionId, rawEvent)) {
      try {
        publisher.ingest(normalized);
        resolveProjectionEventCommit(gateway, sessionId, String(normalized.id));
      } catch (error) {
        rejectProjectionEventCommit(
          gateway,
          sessionId,
          String(normalized.id),
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply hydrated event ${String(normalized.id)}`,
            { cause: error },
          ),
        );
        if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
        gateway.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "replayBufferedEvents",
          sessionId,
        });
      }
    }
  }
  // publisher 已替换且 buffer 已同步补齐；在 usage seed 的异步等待窗口内，新 raw
  // event 直接走上面的 per-session sequence state 进入新 publisher，不再需要二次 replay。
  if (gateway.hydrationBuffers.get(sessionId) === buffer) {
    gateway.hydrationBuffers.delete(sessionId);
  }
  // 冷恢复种子（重放之后）：resume 已把历史会话的上次选型写回 runtime
  // （reconcileResumedRuntimeSettings），而合成/持久化事件里可能没有 ModelSelected——
  // 种子只填事件未触碰的字段，日志有值时以日志为准（冷恢复口径）。
  seedPublisherConfig(gateway, sessionId, publisher);
  if (loaded.usageSeed === undefined) {
    await seedPublisherUsage(gateway, sessionId, publisher, persistedMessages);
  }
  for (const [routeKey, state] of gateway.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (gateway.pausedConnections.has(state.connectionId)) continue;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      emitReservation(gateway, reservation);
    } catch (error) {
      gateway.host.onError?.("v4.hydrate.subscriptionResync", error, {
        phase: "subscriptionResync",
        sessionId,
      });
      scheduleFlush(gateway, routeKey, state, publisher);
    }
  }
  gateway.hydratedSessions.add(sessionId);
  publishCurrentSummaryToIndex(gateway, sessionId);
  return publisher;
}
