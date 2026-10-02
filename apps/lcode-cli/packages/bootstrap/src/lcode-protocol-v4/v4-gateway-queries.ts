import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  type BackgroundBashOutputResult,
} from "@lcode/shared/lcode-protocol-v4";
import type { TurnId } from "@lcode/contracts";
import type {
  ConversationRowTarget,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@lcode/shared/lcode-protocol-v4";
import {
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  v4ConversationRowsRangeParamsSchema,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { type V4GatewayState } from "./v4-gateway-state.js";
import { hasLiveConversation } from "./v4-gateway-publishers.js";

import { ensureColdReadyPublisher, hydratePublisher } from "./v4-gateway-hydration.js";

function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection 为了 row 索引用 string 保存 product turnId；
  // 离开 gateway 调 runtime 文件摘要/回退能力时，需要恢复 contracts 的品牌类型。
  return turnId as TurnId | null;
}

/**
 * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
 * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
 * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
 */
export async function rowsRange(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "detachedLiveSessions"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4ConversationRowsRangeResult> {
  const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !hasLiveConversation(gateway, params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  return publisher.getRowsRange(
    {
      ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
      limit: params.limit,
    },
    // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
    params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
  );
}

/** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */
export async function plans(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "detachedLiveSessions"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4ConversationPlansResult> {
  const params = v4ConversationPlansParamsSchema.parse(rawParams);
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !hasLiveConversation(gateway, params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  return publisher.getPlans();
}

export async function fileChanges(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "detachedLiveSessions"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4ConversationFileChangesResult> {
  const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
  if (!gateway.host.getConversationFileChanges) {
    throw new Error("fault.fileChanges.unsupported");
  }
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !hasLiveConversation(gateway, params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  const resolution = resolveQueryRowTarget(publisher, params, "fileChanges");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return gateway.host.getConversationFileChanges(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export async function backgroundBashOutput(
  gateway: Pick<V4GatewayState, "host">,
  rawParams: unknown,
): Promise<BackgroundBashOutputResult> {
  const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
  // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
  if (!gateway.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return backgroundBashOutputResultSchema.parse(
    await gateway.host.readBackgroundBashOutput(sessionId, workId),
  );
}

export async function fileRewindPreview(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4ConversationFileRewindPreviewResult> {
  const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
  if (!gateway.host.previewConversationFileRewind) {
    throw new Error("fault.fileRewindPreview.unsupported");
  }
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !gateway.host.sessionExists(params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  const resolution = resolveQueryRowTarget(publisher, params, "fileRewindPreview");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return gateway.host.previewConversationFileRewind(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export function resolveQueryRowTarget(
  publisher: ConversationTopicPublisher,
  params: {
    target: ConversationRowTarget;
    baseRevision: number;
    baseLogEpoch: string;
  },
  action: "fileChanges" | "fileRewindPreview",
): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
  const snapshot = publisher.getSnapshot();
  if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
  if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
  const resolution = publisher.resolveRowActionTarget(params.target, action);
  if (!resolution.ok) throw new Error(resolution.reasonCode);
  return resolution;
}
