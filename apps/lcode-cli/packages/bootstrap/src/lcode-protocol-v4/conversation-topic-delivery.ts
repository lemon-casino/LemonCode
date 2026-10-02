import type {
  ConversationTopicFrame,
  SubscribeAck,
  TopicFrameDeliveryKind,
} from "@lcode/shared/lcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { getWireSnapshotForProfile } from "./conversation-topic-queries.js";
import {
  type Subscription,
  type ConversationSubscribeResult,
  type ConversationTopicState,
} from "./conversation-topic-state.js";

/**
 * 排空一个订阅者的 flush buffer 打成一帧（宿主按 flushWindowMs 驱动）。
 * 无新内容返回 null；帧区间 (sentSeq, currentSeq] 覆盖中途被过滤掉的 seq，
 * 保证客户端 `frame.fromSeq === store.seq` 的连续性判定不受 profile 过滤影响。
 */
export function reserveFlush(
  state: Pick<
    ConversationTopicState,
    "nextLogicalFrameSerial" | "now" | "projection" | "subscriptions" | "topic"
  >,
  subscriptionId: string,
): TopicFrameReservation<ConversationTopicFrame> | null {
  const subscription = state.subscriptions.get(subscriptionId);
  if (!subscription) return null;
  if (subscription.inFlight) return subscription.inFlight;
  if (subscription.resyncRequired) {
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return reserveFrame(
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
      true,
      "online",
    );
  }
  if (
    subscription.buffer.length === 0 &&
    subscription.sentSeq === state.projection.getSnapshot().seq
  ) {
    return null;
  }
  const deltas = subscription.buffer;
  const frame: ConversationTopicFrame = {
    ...frameShell(state, subscription),
    fromSeq: subscription.sentSeq,
    toSeq: state.projection.getSnapshot().seq,
    payload: { kind: "deltas", deltas },
  };
  subscription.buffer = [];
  subscription.bufferBytes = 0;
  return reserveFrame(state, subscription, frame, false, "online");
}

/** 旧单测便利面；生产 gateway 必须 reserve 后在 emit-all 成功才 commit。 */
export function flush(
  state: Pick<
    ConversationTopicState,
    "nextLogicalFrameSerial" | "now" | "projection" | "subscriptions" | "topic"
  >,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const reservation = reserveFlush(state, subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function reserveFrame(
  state: Pick<ConversationTopicState, "nextLogicalFrameSerial" | "projection" | "subscriptions">,
  subscription: Subscription,
  frame: ConversationTopicFrame,
  snapshotRecovery: boolean,
  deliveryKind: TopicFrameDeliveryKind,
): TopicFrameReservation<ConversationTopicFrame> {
  let committed = false;
  const reservation: TopicFrameReservation<ConversationTopicFrame> = {
    deliveryKind,
    logicalFrameId: `${subscription.subscriptionId}-lf-${state.nextLogicalFrameSerial++}`,
    logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
    frame,
    commit: () => {
      if (committed) return true;
      if (
        state.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      subscription.sentSeq = frame.toSeq;
      subscription.inFlight = null;
      if (snapshotRecovery) {
        // snapshot 在途时 resyncRequired 会停止收 delta。
        // 若权威水位又推进，下一 reservation 必须再发最新 snapshot。
        subscription.resyncRequired = state.projection.getSnapshot().seq > frame.toSeq;
      }
      committed = true;
      return true;
    },
  };
  subscription.inFlight = reservation;
  return reservation;
}

export function subscribeResult(
  ack: SubscribeAck,
  reservation: TopicFrameReservation<ConversationTopicFrame> | null,
  rollback: () => boolean,
): ConversationSubscribeResult {
  return {
    ack,
    reservation,
    rollback,
    // 兼容旧 publisher 单测：读 frame 即表示本地 transport 已接受。
    // 生产 gateway 只读 reservation，不会触发该 getter。
    get frame() {
      reservation?.commit();
      return reservation?.frame ?? null;
    },
  };
}

export function ackFor(
  state: Pick<ConversationTopicState, "logEpoch">,
  subscription: Subscription,
  mode: SubscribeAck["mode"],
): SubscribeAck {
  return {
    subscriptionId: subscription.subscriptionId,
    mode,
    logEpoch: state.logEpoch,
  };
}

export function frameShell(
  state: Pick<ConversationTopicState, "now" | "topic">,
  subscription: Subscription,
): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
  return {
    topic: state.topic,
    subscriptionId: subscription.subscriptionId,
    sentAt: state.now(),
  };
}
