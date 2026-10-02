import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import { SessionEventType, createSessionEvent } from "../deps.js";
import type { TraceContext, TurnId } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.permissionFullAccessPending || this.pendingInputReservations.has(options.pendingInputId))
    return false;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // rebuildProjection 上方有 await；落锁前必须复查，避免两端同时读到未占用。
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // 事件写失败时 reservation 仍必须保持，不能让第二端重复执行。
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}
