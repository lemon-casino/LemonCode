import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import type { ConversationDelta } from "@lcode/shared/lcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  filterConversationDeltasForProfile,
  utf8JsonByteLength,
} from "@lcode/shared/lcode-protocol-v4";
import { getWireSnapshot, measureWireSnapshotBytes } from "./conversation-topic-queries.js";
import { type ConversationTopicState } from "./conversation-topic-state.js";
import {
  ProjectionPayloadTooLargeError,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  appendConversationSubscriberBuffer,
} from "./conversation-topic-buffer.js";

/** 应用权威事件：投影推进 + 日志记账 + 扇出到各订阅者 flush buffer。 */
export function ingest(
  state: Pick<
    ConversationTopicState,
    | "floorSeq"
    | "log"
    | "logEpoch"
    | "projection"
    | "retention"
    | "subscriberBufferMaxBytes"
    | "subscriberBufferMaxOps"
    | "subscriptions"
    | "topic"
    | "wireSnapshotBytesUpperBound"
  >,
  event: SessionEvent,
): void {
  const projectionLimit =
    event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  const streamingAppend = state.projection.establishedStreamingAppend(event);
  const streamingUpperBound =
    streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
  let deltas: ConversationDelta[] | null;
  if (
    streamingUpperBound !== null &&
    state.wireSnapshotBytesUpperBound + streamingUpperBound <= projectionLimit
  ) {
    deltas = state.projection.applyEvent(event);
    state.wireSnapshotBytesUpperBound += streamingUpperBound;
  } else {
    let candidateBytes = 0;
    deltas = state.projection.applyEventAtomically(event, (snapshot) => {
      candidateBytes = measureWireSnapshotBytes(state, getWireSnapshot(state, snapshot));
      return candidateBytes <= projectionLimit;
    });
    if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
    state.wireSnapshotBytesUpperBound = candidateBytes;
  }
  state.log.push({ seq: event.sequenceNumber, deltas });
  while (state.log.length > state.retention) {
    const evicted = state.log.shift();
    if (evicted) state.floorSeq = evicted.seq;
  }
  if (deltas.length === 0) return;
  for (const subscription of state.subscriptions.values()) {
    if (subscription.resyncRequired) continue;
    const filtered = filterConversationDeltasForProfile(deltas, subscription.profile);
    const next = appendConversationSubscriberBuffer(subscription.buffer, filtered, {
      maxOps: state.subscriberBufferMaxOps,
      maxBytes: state.subscriberBufferMaxBytes,
    });
    if (next.kind === "overflow") {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      continue;
    }
    subscription.buffer = next.deltas;
    subscription.bufferBytes = next.encodedBytes;
  }
}

export function projectionLimitForEvent(event: SessionEvent): number {
  return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
    ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
}
