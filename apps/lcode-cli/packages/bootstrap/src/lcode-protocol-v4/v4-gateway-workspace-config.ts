import type {
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
} from "@lcode/shared/lcode-protocol-v4";
import {
  parseWorkspaceConfigTopic,
  v4ConversationSubscribeParamsSchema,
} from "@lcode/shared/lcode-protocol-v4";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import { type V4SubscribeDispatchResult } from "./v4-gateway-contract.js";
import { type V4GatewayState } from "./v4-gateway-state.js";

import { emitReservation, subscribeDispatch } from "./v4-gateway-delivery.js";

/**
 * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
 */
export async function subscribeWorkspaceConfig(
  gateway: Pick<
    V4GatewayState,
    | "configPublishers"
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const dispatch = await subscribeWorkspaceConfigReserved(gateway, rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeWorkspaceConfigReserved(
  gateway: Pick<
    V4GatewayState,
    | "configPublishers"
    | "controlReservations"
    | "createLogEpoch"
    | "flushStates"
    | "host"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseWorkspaceConfigTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a workspace-config topic: ${params.topic}`);
  }
  const publisher = await ensureConfigPublisher(gateway, workspaceId);
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return subscribeDispatch(
      gateway,
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => flushConfig(gateway, workspaceId),
    );
  } catch (error) {
    // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
    result.rollback();
    throw error;
  }
}

/**
 * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
 * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
 * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
 * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
 */
export function publishWorkspaceConfig(
  gateway: Pick<
    V4GatewayState,
    | "configPublishers"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "publishers"
  >,
  workspaceId: string,
  state: WorkspaceConfigState,
): void {
  if (gateway.disposed) return;
  let publisher = gateway.configPublishers.get(workspaceId);
  if (!publisher) {
    publisher = new WorkspaceConfigPublisher(
      workspaceId,
      gateway.createLogEpoch(`workspace-config/${workspaceId}`),
      gateway.now,
    );
    gateway.configPublishers.set(workspaceId, publisher);
  }
  try {
    if (publisher.publish(state)) flushConfig(gateway, workspaceId);
  } catch (error) {
    gateway.host.onError?.("v4.workspaceConfig.publish", error);
  }
}

export async function pullWorkspaceConfig(
  gateway: Pick<V4GatewayState, "host">,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  if (!gateway.host.getWorkspaceConfig) return null;
  return (await gateway.host.getWorkspaceConfig(workspaceId)) ?? null;
}

/** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
export async function ensureConfigPublisher(
  gateway: Pick<V4GatewayState, "configPublishers" | "createLogEpoch" | "host" | "now">,
  workspaceId: string,
): Promise<WorkspaceConfigPublisher> {
  const existing = gateway.configPublishers.get(workspaceId);
  if (existing) return existing;
  const publisher = new WorkspaceConfigPublisher(
    workspaceId,
    gateway.createLogEpoch(`workspace-config/${workspaceId}`),
    gateway.now,
  );
  const seed = await pullWorkspaceConfig(gateway, workspaceId).catch((error) => {
    gateway.host.onError?.("v4.workspaceConfig.seed", error);
    return null;
  });
  if (seed) publisher.publish(seed);
  // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
  const raced = gateway.configPublishers.get(workspaceId);
  if (raced) return raced;
  gateway.configPublishers.set(workspaceId, publisher);
  return publisher;
}

/** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
export function flushConfig(
  gateway: Pick<
    V4GatewayState,
    | "configPublishers"
    | "controlReservations"
    | "flushStates"
    | "host"
    | "localTtft"
    | "pausedConnections"
    | "publishers"
  >,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = gateway.configPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      gateway.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      emitReservation(gateway, reservation);
    } catch (error) {
      gateway.host.onError?.("v4.workspaceConfig.emit", error);
    }
  }
}
