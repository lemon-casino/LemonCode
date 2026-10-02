import type { SessionEvent } from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import type { SessionsIndexTopicFrame } from "@lcode/shared/lcode-protocol-v4";
import {
  parseSessionsIndexTopic,
  v4ConversationSubscribeParamsSchema,
} from "@lcode/shared/lcode-protocol-v4";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import { type V4SubscribeDispatchResult } from "./v4-gateway-contract.js";
import { type V4GatewayState } from "./v4-gateway-state.js";

import { emitReservation, subscribeDispatch } from "./v4-gateway-delivery.js";

/**
 * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
 * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
 * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
 * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
 */
export function fanOutToIndex(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  sessionId: string,
  event: SessionEvent,
): void {
  if (event.type === SessionEventType.ModelStreaming) return;
  publishCurrentSummaryToIndex(gateway, sessionId);
}

/**
 * 把当前完整 projection 发布到 sessions-index。
 *
 * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
 * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
 * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
 * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
 */
export function publishCurrentSummaryToIndex(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  sessionId: string,
): void {
  const getWorkspaceId = gateway.host.getSessionWorkspaceId;
  if (!getWorkspaceId) return;
  try {
    const workspaceId = getWorkspaceId.call(gateway.host, sessionId);
    if (!workspaceId) return;
    if (gateway.host.isDraftSession?.(sessionId)) return;
    const indexPublisher = gateway.indexPublishers.get(workspaceId);
    if (!indexPublisher) return;
    const conversationPublisher = gateway.publishers.get(sessionId);
    if (!conversationPublisher) return;
    const changed = indexPublisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      resolveIndexMeta(gateway, sessionId),
    );
    if (changed) flushIndex(gateway, workspaceId);
  } catch (error) {
    gateway.host.onError?.("v4.sessionsIndex.ingest", error);
  }
}

/** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
export function resolveIndexMeta(
  gateway: Pick<V4GatewayState, "host" | "now">,
  sessionId: string,
): {
  createdAt: number;
  lastActivityAt: number;
  parentSessionId?: string;
} {
  const meta = gateway.host.getSessionIndexMeta?.(sessionId);
  return {
    createdAt: meta?.createdAt ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? gateway.now(),
    ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
  };
}

/** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
export function flushIndex(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "pausedConnections"
    | "publishers"
  >,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = gateway.indexPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      gateway.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      emitReservation(gateway, reservation);
    } catch (error) {
      gateway.host.onError?.("v4.sessionsIndex.emit", error);
    }
  }
}

/**
 * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
 */
export async function subscribeSessionsIndex(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const dispatch = await subscribeSessionsIndexReserved(gateway, rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeSessionsIndexReserved(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseSessionsIndexTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a sessions-index topic: ${params.topic}`);
  }
  const publisher = await ensureIndexPublisher(gateway, workspaceId, params.legacyTaskIds);
  // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
  gateway.indexPublishers.ensureActive();
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return subscribeDispatch(
      gateway,
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => flushIndex(gateway, workspaceId),
    );
  } catch (error) {
    // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
    // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
    result.rollback();
    throw error;
  }
}

/** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
export async function ensureIndexPublisher(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const existing = gateway.indexPublishers.get(workspaceId);
  const shouldRefreshLegacy =
    Boolean(legacyTaskIds?.length) && Boolean(gateway.host.refreshLegacySessionSummaries);
  if (existing && !shouldRefreshLegacy) return existing;

  return gateway.indexPublishers.runExclusive(workspaceId, () =>
    ensureIndexPublisherExclusive(gateway, workspaceId, legacyTaskIds),
  );
}

/** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
export async function ensureIndexPublisherExclusive(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const refreshed =
    legacyTaskIds && legacyTaskIds.length > 0
      ? ((await gateway.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
      : null;
  const existing = gateway.indexPublishers.get(workspaceId);
  if (existing) {
    // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
    // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
    if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
      flushIndex(gateway, workspaceId);
    }
    return existing;
  }
  const publisher = new SessionsIndexPublisher(
    workspaceId,
    gateway.createLogEpoch(`sessions-index/${workspaceId}`),
    gateway.now,
  );
  // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
  const stored = refreshed ?? (await gateway.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
  for (const summary of stored) publisher.seed(summary);
  // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
  const liveIds = gateway.host.listWorkspaceSessionIds?.(workspaceId) ?? [
    ...gateway.publishers.keys(),
  ];
  for (const sessionId of liveIds) {
    const conversationPublisher = gateway.publishers.get(sessionId);
    if (!conversationPublisher) continue;
    // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
    if (gateway.host.isDraftSession?.(sessionId)) continue;
    publisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      resolveIndexMeta(gateway, sessionId),
    );
  }
  gateway.indexPublishers.set(workspaceId, publisher);
  return publisher;
}
