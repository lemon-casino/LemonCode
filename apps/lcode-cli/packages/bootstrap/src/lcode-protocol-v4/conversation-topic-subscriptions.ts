import {
  DELIVERY_PROFILES,
  coalesceConversationDeltas,
  filterConversationDeltasForProfile,
} from "@lcode/shared/lcode-protocol-v4";
import { getWireSnapshotForProfile } from "./conversation-topic-queries.js";
import {
  reserveFrame,
  subscribeResult,
  ackFor,
  frameShell,
} from "./conversation-topic-delivery.js";
import {
  type Subscription,
  type ConversationSubscribeParams,
  type ConversationSubscribeResult,
  type ConversationTopicState,
} from "./conversation-topic-state.js";

/**
 * 订阅裁决：base.logEpoch 匹配且 base.seq 在保留窗内 → resume，
 * 否则 snapshot。同 connectionId 重订阅 = 替换旧订阅并清其 flush buffer。
 */
export function subscribe(
  state: Pick<
    ConversationTopicState,
    | "floorSeq"
    | "log"
    | "logEpoch"
    | "nextLogicalFrameSerial"
    | "nextSubscriptionSerial"
    | "now"
    | "projection"
    | "subscriptionIdByConnection"
    | "subscriptions"
    | "topic"
  >,
  params: ConversationSubscribeParams,
): ConversationSubscribeResult {
  const result = subscribeReserved(state, params);
  result.reservation?.commit();
  return result;
}

/** 生产 gateway 入口：初始帧也必须等 physical batch 全接受才 commit。 */
export function subscribeReserved(
  state: Pick<
    ConversationTopicState,
    | "floorSeq"
    | "log"
    | "logEpoch"
    | "nextLogicalFrameSerial"
    | "nextSubscriptionSerial"
    | "now"
    | "projection"
    | "subscriptionIdByConnection"
    | "subscriptions"
    | "topic"
  >,
  params: ConversationSubscribeParams,
): ConversationSubscribeResult {
  const previousId = state.subscriptionIdByConnection.get(params.connectionId);
  const previousSubscription =
    previousId === undefined ? undefined : state.subscriptions.get(previousId);
  if (previousId !== undefined) state.subscriptions.delete(previousId);

  const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
  const subscription: Subscription = {
    subscriptionId: `sub-${state.logEpoch}-${state.nextSubscriptionSerial++}`,
    connectionId: params.connectionId,
    profile,
    buffer: [],
    bufferBytes: 0,
    resyncRequired: false,
    sentSeq: 0,
    inFlight: null,
    nextLogicalFrameOrdinal: 1,
  };
  state.subscriptions.set(subscription.subscriptionId, subscription);
  state.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
  const rollback = (): boolean => {
    // initial reservation commit 后 replacement 已 admission，禁止迟到 rollback。
    if (
      subscription.inFlight === null ||
      state.subscriptions.get(subscription.subscriptionId) !== subscription ||
      state.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
    ) {
      return false;
    }
    state.subscriptions.delete(subscription.subscriptionId);
    if (previousId !== undefined && previousSubscription) {
      state.subscriptions.set(previousId, previousSubscription);
      state.subscriptionIdByConnection.set(params.connectionId, previousId);
    } else {
      state.subscriptionIdByConnection.delete(params.connectionId);
    }
    return true;
  };

  const base = params.base;
  const resumable =
    base !== undefined &&
    base.logEpoch === state.logEpoch &&
    base.seq >= state.floorSeq &&
    base.seq <= state.projection.getSnapshot().seq;

  if (!resumable) {
    const reservation = reserveFrame(
      state,
      subscription,
      {
        ...frameShell(state, subscription),
        fromSeq: 0,
        toSeq: state.projection.getSnapshot().seq,
        payload: { kind: "snapshot", snapshot: getWireSnapshotForProfile(state, profile) },
      },
      false,
      "initial",
    );
    return subscribeResult(ackFor(state, subscription, "snapshot"), reservation, rollback);
  }

  // resume：保留窗内 (base.seq, current] 重放，与在线续流同一条 filter→coalesce 管线。
  const replay = coalesceConversationDeltas(
    filterConversationDeltasForProfile(
      state.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
      profile,
    ),
  );
  if (base.seq === state.projection.getSnapshot().seq) {
    subscription.sentSeq = base.seq;
    return subscribeResult(ackFor(state, subscription, "resume"), null, () => false);
  }
  subscription.sentSeq = base.seq;
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
    "initial",
  );
  return subscribeResult(ackFor(state, subscription, "resume"), reservation, rollback);
}

export function unsubscribe(
  state: Pick<ConversationTopicState, "subscriptionIdByConnection" | "subscriptions">,
  subscriptionId: string,
  connectionId?: string,
): void {
  const subscription = state.subscriptions.get(subscriptionId);
  if (!subscription) return;
  if (connectionId !== undefined && subscription.connectionId !== connectionId) {
    return;
  }
  state.subscriptions.delete(subscriptionId);
  if (state.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
    state.subscriptionIdByConnection.delete(subscription.connectionId);
  }
}

export function hasSubscription(
  state: Pick<ConversationTopicState, "subscriptions">,
  subscriptionId: string,
  connectionId?: string,
): boolean {
  const subscription = state.subscriptions.get(subscriptionId);
  return Boolean(
    subscription && (connectionId === undefined || subscription.connectionId === connectionId),
  );
}

/** Resident 回收判定：仍有任一订阅者时该会话不可被去激活。 */
export function hasSubscribers(state: Pick<ConversationTopicState, "subscriptions">): boolean {
  return state.subscriptions.size > 0;
}

export function connectionIdForSubscription(
  state: Pick<ConversationTopicState, "subscriptions">,
  subscriptionId: string,
): string | null {
  return state.subscriptions.get(subscriptionId)?.connectionId ?? null;
}
