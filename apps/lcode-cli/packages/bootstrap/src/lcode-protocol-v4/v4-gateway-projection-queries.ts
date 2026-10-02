import type { ConversationRowTarget, QueueItem } from "@lcode/shared/lcode-protocol-v4";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { type V4GatewayState } from "./v4-gateway-state.js";

export function getQueueItem(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  queueItemId: string,
): QueueItem | null {
  const snapshot = gateway.publishers.get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  return item ?? null;
}

export function hasQueueItemKind(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  kind: QueueItem["kind"],
): boolean {
  return Boolean(
    gateway.publishers
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.kind === kind),
  );
}

export function hasQueuedDelivery(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  delivery: "guide" | "queue",
): boolean {
  return Boolean(
    gateway.publishers
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
  );
}

export function getQueueLength(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
): number {
  return gateway.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
}

/** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */
export function hasResidencyBlockingCommands(
  gateway: Pick<V4GatewayState, "inbox" | "publishers">,
  sessionId: string,
): boolean {
  return getQueueLength(gateway, sessionId) > 0 || gateway.inbox.hasPinnedSessionState(sessionId);
}

export function getQueueHead(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
): {
  autoDrain: boolean;
  dispatchState: QueueItem["dispatch"]["state"];
  kind: QueueItem["kind"];
  queueItemId: string;
  text: string;
} | null {
  const snapshot = gateway.publishers.get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items[0];
  if (!snapshot || !item) return null;
  return {
    autoDrain: snapshot.queue.autoDrain,
    dispatchState: item.dispatch.state,
    kind: item.kind,
    queueItemId: item.queueItemId,
    text: item.text,
  };
}

/**
 * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
 * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
 */
export function getInputRoutingMode(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
  return gateway.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
}

export function getSessionFollowupMode(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
): "queue" | "guide" | null {
  return gateway.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
}

/**
 * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
 * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
 */
export function getMessageIdForRow(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): string | null {
  return gateway.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
}

export function resolveRowActionTarget(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
) {
  return gateway.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
}

/** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */
export function getMessageIdsForTurnRow(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): string[] {
  return gateway.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
}

/** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */
export function isLatestAssistantSegmentRow(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): boolean | null {
  return gateway.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
}

export function resolveStableForkCandidate(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
) {
  return gateway.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
}

/** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
export function isLatestRetryAssistantRow(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): boolean | null {
  return gateway.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
}

/** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */
export function isLatestEditableUserRow(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): boolean | null {
  return gateway.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
}

/** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
export function getTurnIdForRow(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): string | null {
  return gateway.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
}

/**
 * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
 * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
 */
export function getTurnRewindAnchor(
  gateway: Pick<V4GatewayState, "publishers">,
  sessionId: string,
  rowId: number,
): string | null {
  return gateway.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
}
