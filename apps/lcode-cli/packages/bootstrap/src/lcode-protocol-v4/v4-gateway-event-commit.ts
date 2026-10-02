import { SessionEventType } from "@lcode/contracts";
import { type ProjectionEventCommitWaiter, type V4GatewayState } from "./v4-gateway-state.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-errors.js";
import { hydratePublisher } from "./v4-gateway-hydration.js";
import { getOrCreateRawSequenceState, rejectProjectionEventCommit } from "./v4-gateway-sequence.js";

const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;

/** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
export function waitForProjectionEventCommit(
  gateway: Pick<V4GatewayState, "disposed" | "projectionEventCommitWaiters" | "rawSequenceStates">,
  sessionId: string,
  eventId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (gateway.disposed) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway is disposed",
      ),
    );
  }
  const state = getOrCreateRawSequenceState(gateway, sessionId);
  if (state.appliedEventIds.has(eventId)) return Promise.resolve();
  const failed = state.failedEventById.get(eventId);
  if (failed) return Promise.reject(failed);
  if (options.signal?.aborted) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.aborted",
        `projection event commit wait aborted: ${eventId}`,
        { cause: options.signal.reason },
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const byEvent = gateway.projectionEventCommitWaiters.get(sessionId) ?? new Map();
    gateway.projectionEventCommitWaiters.set(sessionId, byEvent);
    const waiters = byEvent.get(eventId) ?? new Set();
    byEvent.set(eventId, waiters);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      waiters.delete(waiter);
      if (waiters.size === 0) byEvent.delete(eventId);
      if (byEvent.size === 0) gateway.projectionEventCommitWaiters.delete(sessionId);
    };
    const waiter: ProjectionEventCommitWaiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    };
    const onAbort = () => {
      // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
      // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
      // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
      rejectProjectionEventCommit(
        gateway,
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal?.reason },
        ),
      );
    };
    const timeout = setTimeout(() => {
      rejectProjectionEventCommit(
        gateway,
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.timeout",
          `projection event commit wait timed out: ${eventId}`,
        ),
      );
    }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
    timeout.unref?.();
    waiters.add(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
export async function waitForPermissionGrantCommit(
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
  eventId: string,
): Promise<void> {
  const state = getOrCreateRawSequenceState(gateway, sessionId);
  if (state.failedEventById.has(eventId)) {
    const event = state.recentRawEventsById.get(eventId);
    if (
      event?.type !== SessionEventType.SessionModeChanged ||
      !(event.payload as { permissionGrant?: unknown }).permissionGrant
    ) {
      throw new Error("Permission grant event unavailable for recovery");
    }
    await gateway.hydrationInFlight.get(sessionId);
    gateway.hydratedSessions.delete(sessionId);
    await hydratePublisher(gateway, sessionId, undefined, true);
  }
  await waitForProjectionEventCommit(gateway, sessionId, eventId);
}
