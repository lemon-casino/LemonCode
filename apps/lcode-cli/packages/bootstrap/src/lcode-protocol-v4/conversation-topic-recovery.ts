import type { ConversationTopicFrame } from "@lcode/shared/lcode-protocol-v4";
import {
  coalesceConversationDeltas,
  filterConversationDeltasForProfile,
} from "@lcode/shared/lcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { getWireSnapshotForProfile } from "./conversation-topic-queries.js";
import {
  reserveFrame,
  subscribeResult,
  ackFor,
  frameShell,
} from "./conversation-topic-delivery.js";
import {
  type Subscription,
  type ConversationSubscribeResult,
  type ConversationResyncRequest,
  type ConversationTopicState,
} from "./conversation-topic-state.js";
import { appendConversationSubscriberBuffer } from "./conversation-topic-buffer.js";

/**
 * 活跃订阅 same-sub 恢复：客户端 base 是唯一恢复起点，不能拿 sentSeq
 * 猜客户端已应用到哪里。新 recovery admission 会作废旧 reservation；迟到 commit
 * 因 inFlight 身份不再匹配而返回 false。
 */
export function resyncReserved(
  state: Pick<
    ConversationTopicState,
    | "floorSeq"
    | "log"
    | "logEpoch"
    | "nextLogicalFrameSerial"
    | "now"
    | "projection"
    | "subscriberBufferMaxBytes"
    | "subscriberBufferMaxOps"
    | "subscriptions"
    | "topic"
  >,
  subscriptionId: string,
  request: ConversationResyncRequest,
): ConversationSubscribeResult | null {
  const subscription = state.subscriptions.get(subscriptionId);
  if (!subscription) return null;

  const previous = {
    buffer: subscription.buffer,
    bufferBytes: subscription.bufferBytes,
    resyncRequired: subscription.resyncRequired,
    sentSeq: subscription.sentSeq,
    inFlight: subscription.inFlight,
  };

  // 旧 resync 会先 commit 当前 reservation，再基于服务端 sentSeq 发 snapshot，
  // 这会把客户端未收到的帧误记为已送达。same-sub recovery 必须直接 supersede。
  subscription.inFlight = null;
  subscription.buffer = [];
  subscription.bufferBytes = 0;
  subscription.resyncRequired = false;

  const base = request.base;
  const resumable =
    !request.forceSnapshot &&
    base !== null &&
    base.logEpoch === state.logEpoch &&
    base.seq >= state.floorSeq &&
    base.seq <= state.projection.getSnapshot().seq;

  if (!resumable) {
    subscription.sentSeq = 0;
    const reservation = reserveFrame(
      state,
      subscription,
      {
        ...frameShell(state, subscription),
        fromSeq: 0,
        toSeq: state.projection.getSnapshot().seq,
        payload: {
          kind: "snapshot",
          snapshot: getWireSnapshotForProfile(state, subscription.profile),
        },
      },
      false,
      "recovery",
    );
    return subscribeResult(
      ackFor(state, subscription, "snapshot"),
      reservation,
      resyncRollback(state, subscription, reservation, previous),
    );
  }

  subscription.sentSeq = base.seq;
  const replay = coalesceConversationDeltas(
    filterConversationDeltasForProfile(
      state.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
      subscription.profile,
    ),
  );
  const reservation = reserveFrame(
    state,
    subscription,
    {
      ...frameShell(state, subscription),
      fromSeq: base.seq,
      toSeq: state.projection.getSnapshot().seq,
      payload: { kind: "deltas", deltas: replay },
    },
    false,
    "recovery",
  );
  return subscribeResult(
    ackFor(state, subscription, "resume"),
    reservation,
    resyncRollback(state, subscription, reservation, previous),
  );
}

export function resyncRollback(
  state: Pick<
    ConversationTopicState,
    "subscriberBufferMaxBytes" | "subscriberBufferMaxOps" | "subscriptions"
  >,
  subscription: Subscription,
  reservation: TopicFrameReservation<ConversationTopicFrame>,
  previous: Pick<
    Subscription,
    "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
  >,
): () => boolean {
  let rolledBack = false;
  return (): boolean => {
    if (rolledBack) return true;
    if (
      state.subscriptions.get(subscription.subscriptionId) !== subscription ||
      subscription.inFlight !== reservation
    ) {
      return false;
    }
    const recoveryBuffer = subscription.buffer;
    const recoveryResyncRequired = subscription.resyncRequired;
    const merged = appendConversationSubscriberBuffer(previous.buffer, recoveryBuffer, {
      maxOps: state.subscriberBufferMaxOps,
      maxBytes: state.subscriberBufferMaxBytes,
    });
    if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
    } else {
      subscription.buffer = merged.deltas;
      subscription.bufferBytes = merged.encodedBytes;
      subscription.resyncRequired = false;
    }
    subscription.sentSeq = previous.sentSeq;
    subscription.inFlight = previous.inFlight;
    rolledBack = true;
    return true;
  };
}

/** 溢出降级：清缓冲、回发 snapshot 帧重对齐。 */
export function resync(
  state: Pick<
    ConversationTopicState,
    | "floorSeq"
    | "log"
    | "logEpoch"
    | "nextLogicalFrameSerial"
    | "now"
    | "projection"
    | "subscriberBufferMaxBytes"
    | "subscriberBufferMaxOps"
    | "subscriptions"
    | "topic"
  >,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const reservation = resyncReserved(state, subscriptionId, {
    base: null,
    forceSnapshot: true,
  })?.reservation;
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}
