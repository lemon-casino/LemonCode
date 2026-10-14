import type { EventId, SessionEvent, SessionId, TraceId, TurnId } from "@lcode/contracts";
import { HYDRATION_TRACE_ID } from "./projection-state.js";
import type { PushEvent } from "./transcript-hydration-types.js";

/** 单次 transcript 合成的事件 owner；展示事件序列与缺省源时间序位分别递增。 */
export function createHydrationEventWriter(input: { sessionId: string; baseTimestampMs: number }): {
  events: SessionEvent[];
  push: PushEvent;
  currentImplicitTimestampMs(): number;
} {
  const events: SessionEvent[] = [];
  let sequenceNumber = 0;
  let sourceEventOrdinal = 0;
  const push: PushEvent = (type, payload, turnId, sourceTimestampMs, representedEventCount = 1) => {
    sequenceNumber += 1;
    // 词级恢复事件折叠后，不能直接拿变短的 wire seq 推导 createdAt，
    // 否则后续思考、工具和缺少时间的旧轮次都会漂移。源序位仍代表旧事件数量。
    sourceEventOrdinal += representedEventCount;
    events.push({
      id: `hydrate-${sequenceNumber}` as EventId,
      sessionId: input.sessionId as SessionId,
      turnId: turnId as TurnId | undefined,
      type,
      timestamp: new Date(sourceTimestampMs ?? input.baseTimestampMs + sourceEventOrdinal),
      traceId: HYDRATION_TRACE_ID as TraceId,
      sequenceNumber,
      payload,
    });
  };
  return {
    events,
    push,
    currentImplicitTimestampMs: () => input.baseTimestampMs + sourceEventOrdinal,
  };
}
