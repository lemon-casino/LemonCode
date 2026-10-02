import { v4ConnectionFlowParamsSchema } from "@lcode/shared/lcode-protocol-v4";
import { type V4GatewayState } from "./v4-gateway-state.js";
import { flushIndex } from "./v4-gateway-sessions-index.js";
import { flushConfig } from "./v4-gateway-workspace-config.js";
import { emitReservation } from "./v4-gateway-delivery.js";

export function setConnectionFlowState(
  gateway: Pick<
    V4GatewayState,
    | "attachmentUploads"
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
): void {
  const params = v4ConnectionFlowParamsSchema.parse(rawParams);
  if (params.state === "closed") {
    gateway.pausedConnections.delete(params.connectionId);
    clearConnectionFlushTimers(gateway, params.connectionId);
    gateway.attachmentUploads.clearConnection(params.connectionId);
    return;
  }
  if (params.state === "saturated") {
    if (gateway.pausedConnections.has(params.connectionId)) return;
    gateway.pausedConnections.add(params.connectionId);
    clearConnectionFlushTimers(gateway, params.connectionId);
    return;
  }
  if (!gateway.pausedConnections.delete(params.connectionId)) return;
  flushConnection(gateway, params.connectionId);
}

export function clearConnectionFlushTimers(
  gateway: Pick<V4GatewayState, "flushStates">,
  connectionId: string,
): void {
  for (const state of gateway.flushStates.values()) {
    if (state.connectionId !== connectionId || state.timer === null) continue;
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function flushConnection(
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
  connectionId: string,
): void {
  for (const [routeKey, state] of gateway.flushStates) {
    if (state.connectionId !== connectionId) continue;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const publisher = gateway.publishers.get(state.sessionId);
    if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
      gateway.flushStates.delete(routeKey);
      continue;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      emitReservation(gateway, reservation);
    } catch (error) {
      gateway.host.onError?.("v4.frame.emit", error);
    }
  }
  for (const workspaceId of gateway.indexPublishers.keys()) {
    flushIndex(gateway, workspaceId, connectionId);
  }
  for (const workspaceId of gateway.configPublishers.keys()) {
    flushConfig(gateway, workspaceId, connectionId);
  }
}
