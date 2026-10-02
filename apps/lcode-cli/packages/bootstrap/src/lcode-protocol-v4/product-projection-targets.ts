// 公共行命令的稳定目标解析，仍读取同一次 materialization 的 actions。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type {
  ProductProjectionState,
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  StableForkCandidateResolution,
} from "./product-projection-state.js";
import type { ConversationRowTarget } from "@lcode/shared/lcode-protocol-v4";
import { findRow, rewindAnchorForRows } from "./product-projection-rows.js";

type ResolveEditTargetHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "messageIdByRowId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "currentEditableEntityId"
>;

type ResolveEditTargetByEntityIdHost = Pick<
  ProductProjectionState,
  "editTargetByEntityId" | "currentEditableEntityId"
>;

type ResolveRowActionTargetHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "currentEditableEntityId"
  | "runtimeTurnIdByProductTurnId"
>;

type GetMessageIdsForTurnRowHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "runtimeTurnIdByProductTurnId"
>;

type IsLatestAssistantSegmentRowHost = Pick<ProductProjectionState, "snapshot" | "rowIndexById">;

type ResolveStableForkCandidateHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "messageIdByRowId"
  | "turnHeaderRowIdByTurnId"
  | "runtimeTurnIdByProductTurnId"
>;

type IsLatestRetryAssistantRowHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "messageIdByRowId"
>;

type GetTurnRewindAnchorHost = Pick<ProductProjectionState, "snapshot" | "messageIdByRowId">;

export function resolveEditTarget(
  host: ResolveEditTargetHost,
  rowId: number,
): ConversationEditTarget | null {
  if (!isLatestEditableUserRow(host, rowId)) return null;
  const entityId = host.entityIdByRowId.get(rowId);
  return entityId ? resolveEditTargetByEntityId(host, entityId) : null;
}

export function resolveEditTargetByEntityId(
  host: ResolveEditTargetByEntityIdHost,
  entityId: string,
): ConversationEditTarget | null {
  if (entityId !== host.currentEditableEntityId) return null;
  const target = host.editTargetByEntityId.get(entityId);
  return target ? { ...target, intent: { ...target.intent } } : null;
}

/**
 * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
 * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
 * 不得再各自按位置、phase 或文本重算。
 */
export function resolveRowActionTarget(
  host: ResolveRowActionTargetHost,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  const row = findRow(host, target.rowId);
  if (!row || host.entityIdByRowId.get(target.rowId) !== target.entityId) {
    return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
  }
  if (action === "editUserQuery") {
    const editTarget = resolveEditTargetByEntityId(host, target.entityId);
    if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, editTarget };
  }
  if (action === "retryTurn") {
    const messageId = host.messageIdByRowId.get(row.rowId);
    const userRow = host.snapshot.rows.window.find(
      (candidate) =>
        candidate.turnId === row.turnId &&
        candidate.kind === "userInput" &&
        candidate.origin === "realUser",
    );
    const userEntityId = userRow ? host.entityIdByRowId.get(userRow.rowId) : undefined;
    const editTarget = userEntityId ? host.editTargetByEntityId.get(userEntityId) : undefined;
    if (row.actions?.canRetry !== true || !messageId || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId, editTarget };
  }
  if (action === "forkAssistant") {
    const messageId = host.messageIdByRowId.get(row.rowId);
    if (row.actions?.canFork !== true || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setAssistantFeedback") {
    const messageId = host.messageIdByRowId.get(row.rowId);
    if (row.kind !== "assistantText" || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (row.kind !== "turnHeader") {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  if (
    (action === "applyFileRewind" || action === "fileRewindPreview") &&
    (!row.fileChanges || row.actions?.canRewindFiles !== true)
  ) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  return {
    ok: true,
    action,
    row,
    messageIds: getMessageIdsForTurnRow(host, row.rowId),
  };
}

/**
 * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
 * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
 */
export function getMessageIdsForTurnRow(
  host: GetMessageIdsForTurnRowHost,
  rowId: number,
): string[] {
  const row = findRow(host, rowId);
  if (!row) return [];
  const messageIds = new Set<string>();
  const runtimeTurnId = host.runtimeTurnIdByProductTurnId.get(row.turnId);
  // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
  // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
  // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
  if (runtimeTurnId && runtimeTurnId !== row.turnId) {
    messageIds.add(row.turnId);
  }
  for (const candidate of host.snapshot.rows.window) {
    if (candidate.turnId !== row.turnId) continue;
    const messageId = host.messageIdByRowId.get(candidate.rowId);
    if (messageId) messageIds.add(messageId);
  }
  for (const [messageId, continuationRowId] of host.outputContinuationRowIdByMessageId) {
    const continuationRow = findRow(host, continuationRowId);
    if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
  }
  return [...messageIds];
}

/**
 * core 侧强校验：
 * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
 * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
 */
export function isLatestAssistantSegmentRow(
  host: IsLatestAssistantSegmentRowHost,
  rowId: number,
): boolean {
  const row = findRow(host, rowId);
  if (row?.kind !== "assistantText") return false;
  for (let index = host.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const candidate = host.snapshot.rows.window[index]!;
    if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
      return candidate.rowId === rowId;
    }
  }
  return false;
}

/**
 * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
 * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
 */
export function resolveStableForkCandidate(
  host: ResolveStableForkCandidateHost,
  rowId: number,
): StableForkCandidateResolution {
  if (host.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
    return { ok: false, reasonCode: "guard.compactOperationLock" };
  }
  const row = findRow(host, rowId);
  if (row?.kind !== "assistantText") {
    return { ok: false, reasonCode: "guard.forkAssistantOnly" };
  }
  const headerRowId = host.turnHeaderRowIdByTurnId.get(row.turnId);
  const header = headerRowId === undefined ? undefined : findRow(host, headerRowId);
  if (
    row.state !== "complete" ||
    row.actions?.canFork !== true ||
    header?.kind !== "turnHeader" ||
    header.state !== "completedSuccess" ||
    !isLatestAssistantSegmentRow(host, rowId)
  ) {
    return { ok: false, reasonCode: "guard.forkTargetNotStable" };
  }
  const boundaryMessageId = host.messageIdByRowId.get(rowId);
  if (!boundaryMessageId) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const startMessageId =
    host.snapshot.rows.window
      .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
      .map((candidate) => host.messageIdByRowId.get(candidate.rowId))
      .find((messageId): messageId is string => Boolean(messageId)) ?? null;
  return {
    ok: true,
    candidate: {
      productTurnId: row.turnId,
      transcriptTurnId: host.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
      startMessageId,
      boundaryMessageId,
    },
  };
}

/** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
export function isLatestRetryAssistantRow(
  host: IsLatestRetryAssistantRowHost,
  rowId: number,
): boolean {
  const row = findRow(host, rowId);
  return Boolean(
    row?.kind === "assistantText" &&
    row.actions?.canRetry === true &&
    host.messageIdByRowId.has(rowId),
  );
}

/** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
export function isLatestEditableUserRow(
  host: IsLatestRetryAssistantRowHost,
  rowId: number,
): boolean {
  const row = findRow(host, rowId);
  return Boolean(
    row?.kind === "userInput" &&
    row.origin === "realUser" &&
    row.actions?.canEdit === true &&
    host.messageIdByRowId.has(rowId),
  );
}

/** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
export function getTurnIdForRow(
  host: IsLatestAssistantSegmentRowHost,
  rowId: number,
): string | null {
  return findRow(host, rowId)?.turnId ?? null;
}

/**
 * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
 * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
 * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
 */
export function getTurnRewindAnchor(host: GetTurnRewindAnchorHost, rowId: number): string | null {
  return rewindAnchorForRows(host, host.snapshot.rows.window, rowId);
}
