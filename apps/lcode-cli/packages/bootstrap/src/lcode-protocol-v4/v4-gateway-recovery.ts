import type { RoutedTopicFrame } from "@lcode/shared/lcode-protocol-v4";
import {
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConversationResyncParamsSchema,
} from "@lcode/shared/lcode-protocol-v4";
import { type V4SubscribeDispatchResult } from "./v4-gateway-contract.js";
import { type V4GatewayState } from "./v4-gateway-state.js";
import { flushIndex } from "./v4-gateway-sessions-index.js";
import { flushConfig } from "./v4-gateway-workspace-config.js";
import { scheduleFlush, subscribeDispatch, subscriptionRouteKey } from "./v4-gateway-delivery.js";

/**
 * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
 * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
 */
export function resyncReserved(
  gateway: Pick<
    V4GatewayState,
    | "configPublishers"
    | "controlReservations"
    | "flushStates"
    | "host"
    | "indexPublishers"
    | "localTtft"
    | "pausedConnections"
    | "publishers"
  >,
  rawParams: unknown,
): V4SubscribeDispatchResult<RoutedTopicFrame> {
  const params = v4ConversationResyncParamsSchema.parse(rawParams);
  const request = {
    base: params.base,
    ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
  };
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId !== null) {
    const publisher = gateway.publishers.get(sessionId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const flushState = gateway.flushStates.get(routeKey);
    if (flushState?.timer) {
      clearTimeout(flushState.timer);
      flushState.timer = null;
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return subscribeDispatch(gateway, result.ack, result.reservation, () => {
        const state = gateway.flushStates.get(routeKey);
        if (state) scheduleFlush(gateway, routeKey, state, publisher);
      });
    } catch (error) {
      // physical encode 在 ACK admission 前失败时，same-sub recovery
      // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
      result.rollback();
      if (flushState) scheduleFlush(gateway, routeKey, flushState, publisher);
      throw error;
    }
  }

  const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
  if (indexWorkspaceId !== null) {
    const publisher = gateway.indexPublishers.get(indexWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return subscribeDispatch(
        gateway,
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => flushIndex(gateway, indexWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }

  const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
  if (configWorkspaceId !== null) {
    const publisher = gateway.configPublishers.get(configWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return subscribeDispatch(
        gateway,
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => flushConfig(gateway, configWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }
  throw new Error(`Unsupported topic: ${params.topic}`);
}
