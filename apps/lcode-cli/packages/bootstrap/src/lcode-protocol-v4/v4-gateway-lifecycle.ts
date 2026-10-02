import type { SessionEvent } from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import { type V4GatewayState } from "./v4-gateway-state.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-errors.js";
import { ingest } from "./v4-gateway-ingest.js";
import { flushIndex } from "./v4-gateway-sessions-index.js";
import { deleteBinaryReadCacheEntry } from "./v4-gateway-binary-cache.js";
import { rejectProjectionEventWaiters } from "./v4-gateway-sequence.js";

/** detached subagent child 终态后无订阅者时，publisher 由低频 tick 释放前的保留时长。 */
export const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;

// 所有回收入口借用同一组资源；清理递归不会创建新的 owner 或补偿队列。
type SessionRuntimeCleanupState = Pick<
  V4GatewayState,
  | "attachmentUploads"
  | "binaryReadCache"
  | "binaryReadCacheBytes"
  | "controlReservations"
  | "detachedChildParent"
  | "detachedChildrenByParent"
  | "detachedLiveSessions"
  | "detachedTerminalAt"
  | "flushStates"
  | "host"
  | "hydratedSessions"
  | "hydrationBuffers"
  | "hydrationInFlight"
  | "inbox"
  | "indexPublishers"
  | "localTtft"
  | "pausedConnections"
  | "projectionEventCommitWaiters"
  | "projectionFaultedSessions"
  | "publishers"
  | "rawSequenceStates"
  | "readyFlights"
  | "telemetryNormalizer"
>;

/**
 * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
 * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
 */
export function ingestDetachedLiveSession(
  gateway: Pick<
    V4GatewayState,
    | "controlReservations"
    | "createLogEpoch"
    | "cuaPermissionNormalizer"
    | "detachedChildParent"
    | "detachedChildrenByParent"
    | "detachedLiveSessions"
    | "detachedTerminalAt"
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
  parentSessionId?: string,
): void {
  if (!gateway.detachedLiveSessions.has(sessionId)) {
    gateway.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
  }
  gateway.detachedLiveSessions.add(sessionId);
  if (parentSessionId && parentSessionId !== sessionId) {
    gateway.detachedChildParent.set(sessionId, parentSessionId);
    let children = gateway.detachedChildrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set();
      gateway.detachedChildrenByParent.set(parentSessionId, children);
    }
    children.add(sessionId);
  }
  // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
  // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    gateway.detachedTerminalAt.set(sessionId, Date.now());
  } else if (event.type === SessionEventType.TurnStarted) {
    gateway.detachedTerminalAt.delete(sessionId);
  }
  ingest(gateway, sessionId, event);
}

/**
 * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
 * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
 */
export function pruneDetachedChildPublishers(
  gateway: SessionRuntimeCleanupState,
  nowMs: number = Date.now(),
  graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
): number {
  let released = 0;
  for (const [childId, terminalAt] of Array.from(gateway.detachedTerminalAt)) {
    if (nowMs - terminalAt < graceMs) continue;
    if (gateway.host.sessionExists(childId)) continue;
    if (gateway.publishers.get(childId)?.hasSubscribers()) continue;
    releaseDetachedChild(gateway, childId);
    released += 1;
  }
  return released;
}

export function releaseDetachedChild(gateway: SessionRuntimeCleanupState, childId: string): void {
  gateway.host.onDebug?.(`release detached live child publisher session=${childId}`);
  cleanupSessionRuntime(gateway, childId, { clearCommandInbox: false, notifyIndexRemoved: false });
}

/** 会话关闭：清 publisher 与其全部订阅调度；hydration 标记同清（重开走冷启动重建）；
 *  并从其 workspace index 移除该会话（session.removed 推给列表订阅者）。 */
export function disposeSession(gateway: SessionRuntimeCleanupState, sessionId: string): void {
  cleanupSessionRuntime(gateway, sessionId, {
    clearCommandInbox: false,
    notifyIndexRemoved: true,
  });
}

/**
 * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
 * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
 * 保留，再次订阅经冷恢复透明重建。
 */
export function deactivateSession(gateway: SessionRuntimeCleanupState, sessionId: string): void {
  cleanupSessionRuntime(gateway, sessionId, {
    clearCommandInbox: true,
    notifyIndexRemoved: false,
  });
}

/**
 * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
 * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
 */
export function assertSessionRuntimeDeactivatable(
  gateway: Pick<V4GatewayState, "inbox">,
  sessionId: string,
): void {
  if (!gateway.inbox.hasPinnedSessionState(sessionId)) return;
  throw new Error(`Session command inbox is still pinned: ${sessionId}`);
}

/** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
export function hasConversationSubscribers(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
): boolean {
  return gateway.publishers.get(sessionId)?.hasSubscribers() ?? false;
}

/**
 * 内存诊断计数器。只读 size，不触碰状态。
 * detachedLive 用于观察子 session publisher 是否随父 session 释放。
 */
export function collectMemoryDiagnostics(
  gateway: Pick<
    V4GatewayState,
    "detachedLiveSessions" | "detachedTerminalAt" | "publishers" | "rawSequenceStates"
  >,
): Record<string, number> {
  return {
    publishers: gateway.publishers.size,
    detachedLive: gateway.detachedLiveSessions.size,
    detachedTerminal: gateway.detachedTerminalAt.size,
    rawSeqStates: gateway.rawSequenceStates.size,
  };
}

export function cleanupSessionRuntime(
  gateway: SessionRuntimeCleanupState,
  sessionId: string,
  options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
): void {
  if (options.clearCommandInbox) {
    // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
    // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
    assertSessionRuntimeDeactivatable(gateway, sessionId);
  }
  rejectProjectionEventWaiters(
    gateway,
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.disposed",
      `conversation session disposed while waiting for projection event commit: ${sessionId}`,
    ),
  );
  gateway.attachmentUploads.clearSession(sessionId);
  for (const [key, entry] of gateway.binaryReadCache) {
    if (entry.sessionId === sessionId) deleteBinaryReadCacheEntry(gateway, key);
  }
  if (options.notifyIndexRemoved) {
    // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
    try {
      const workspaceId = gateway.host.getSessionWorkspaceId?.(sessionId) ?? null;
      if (workspaceId !== null) {
        const indexPublisher = gateway.indexPublishers.get(workspaceId);
        // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
        // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
        if (indexPublisher?.removeSession(sessionId)) {
          flushIndex(gateway, workspaceId);
        }
      }
    } catch (error) {
      gateway.host.onError?.("v4.sessionsIndex.remove", error);
    }
  }
  for (const [routeKey, state] of gateway.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (state.timer) clearTimeout(state.timer);
    gateway.flushStates.delete(routeKey);
  }
  gateway.publishers.delete(sessionId);
  gateway.hydratedSessions.delete(sessionId);
  const hydrationBuffer = gateway.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) hydrationBuffer.cancelled = true;
  gateway.hydrationBuffers.delete(sessionId);
  gateway.hydrationInFlight.delete(sessionId);
  gateway.readyFlights.delete(sessionId);
  gateway.rawSequenceStates.delete(sessionId);
  if (options.clearCommandInbox) gateway.inbox.clearSession(sessionId);
  gateway.telemetryNormalizer.clearSession(sessionId);
  gateway.detachedLiveSessions.delete(sessionId);
  gateway.projectionFaultedSessions.delete(sessionId);
  // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
  gateway.detachedTerminalAt.delete(sessionId);
  const parentId = gateway.detachedChildParent.get(sessionId);
  if (parentId !== undefined) {
    gateway.detachedChildParent.delete(sessionId);
    const siblings = gateway.detachedChildrenByParent.get(parentId);
    siblings?.delete(sessionId);
    if (siblings && siblings.size === 0) gateway.detachedChildrenByParent.delete(parentId);
  }
  const children = gateway.detachedChildrenByParent.get(sessionId);
  if (children) {
    gateway.detachedChildrenByParent.delete(sessionId);
    for (const childId of children) {
      gateway.detachedChildParent.delete(childId);
      if (gateway.host.sessionExists(childId)) continue;
      releaseDetachedChild(gateway, childId);
    }
  }
}

export function dispose(
  gateway: Pick<
    V4GatewayState,
    | "attachmentPruneTimer"
    | "attachmentUploads"
    | "binaryReadCache"
    | "binaryReadCacheBytes"
    | "coldResume"
    | "configPublishers"
    | "detachedChildParent"
    | "detachedChildrenByParent"
    | "detachedLiveSessions"
    | "detachedTerminalAt"
    | "disposed"
    | "flushStates"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "projectionFaultedSessions"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
    | "telemetryEventIds"
  >,
): void {
  gateway.disposed = true;
  gateway.localTtft.clear();
  for (const sessionId of gateway.projectionEventCommitWaiters.keys()) {
    rejectProjectionEventWaiters(
      gateway,
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway disposed while waiting for projection event commit",
      ),
    );
  }
  clearInterval(gateway.attachmentPruneTimer);
  gateway.attachmentUploads.clear();
  gateway.binaryReadCache.clear();
  gateway.binaryReadCacheBytes = 0;
  for (const state of gateway.flushStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  gateway.flushStates.clear();
  gateway.publishers.clear();
  gateway.hydratedSessions.clear();
  for (const buffer of gateway.hydrationBuffers.values()) buffer.cancelled = true;
  gateway.hydrationBuffers.clear();
  gateway.hydrationInFlight.clear();
  gateway.readyFlights.clear();
  gateway.rawSequenceStates.clear();
  gateway.telemetryEventIds.clear();
  gateway.detachedLiveSessions.clear();
  gateway.detachedChildParent.clear();
  gateway.detachedChildrenByParent.clear();
  gateway.detachedTerminalAt.clear();
  gateway.projectionFaultedSessions.clear();
  gateway.coldResume.clear();
  gateway.indexPublishers.dispose();
  gateway.configPublishers.clear();
  gateway.pausedConnections.clear();
}
