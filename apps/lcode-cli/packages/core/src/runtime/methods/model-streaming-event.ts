import { SessionEventType } from "../deps.js";
import type { ModelStreamingPayload, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function emitModelStreamingEvent(
  this: AgentRuntimeInternal,
  payload: ModelStreamingPayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  const event = this.createEvent(SessionEventType.ModelStreaming, payload, traceContext);
  await this.appendEvent(event, traceContext);
  events.push(event);
}
