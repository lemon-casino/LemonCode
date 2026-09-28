import {
  SessionEventType,
  type SessionEvent,
  type CompactLifecyclePayload,
} from "@lcode/contracts";
import { LOCAL_TTFT_MAX_DETAILS, type LocalTtftFacts } from "@lcode/shared";

/** Compact 的实际生命周期可以与 main attempt 交错，不能由主请求差额推算。 */
export function observeLocalTtftCompaction(
  record: LocalTtftFacts,
  event: SessionEvent,
  now: number,
): boolean {
  if (record.turnId !== event.turnId || record.outputAt !== undefined) return false;
  if (
    event.type !== SessionEventType.CompactStarted &&
    event.type !== SessionEventType.CompactCompleted &&
    event.type !== SessionEventType.CompactFailed
  )
    return false;
  const payload = event.payload as CompactLifecyclePayload;
  const details = (record.details ??= []);
  const id = `compact:${payload.operationId}`;
  let detail = details.find((item) => item.id === id);
  if (!detail && event.type === SessionEventType.CompactStarted) {
    if (details.length >= LOCAL_TTFT_MAX_DETAILS) {
      record.truncated = true;
      return true;
    }
    detail = { id, stage: "compaction", start: now, source: "cli" };
    details.push(detail);
  }
  if (detail && event.type !== SessionEventType.CompactStarted && detail.end === undefined) {
    if (now < detail.start) {
      record.clockInvalid = true;
      return true;
    }
    detail.end = now;
    detail.outcome =
      payload.status === "interrupted"
        ? "cancelled"
        : event.type === SessionEventType.CompactCompleted
          ? "completed"
          : "failed";
  }
  return true;
}
