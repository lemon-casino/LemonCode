import { SessionEventType, createSessionEvent, traceContextToLogContext } from "../deps.js";
import type { PendingSteerInputInfo, SessionEvent, TraceContext, TurnId } from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  if (this.activeTurn !== options.activeTurn) return;
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // （重启不保留队列）：先清扫账本残留 admitted——事件日志是
  // 内存的，崩溃后投影里什么都没有，账本是唯一痕迹（含 background wake：后台
  // 子进程随 CLI 重启已死，其未消费通知不可恢复）。留痕（discarded/session_resumed）
  // 不静默，用户/诊断可查「这条输入去哪了」。
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}
