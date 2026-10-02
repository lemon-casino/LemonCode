// 行身份、已有索引和 runtime/product turn 寻址；不新增索引或行状态。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState, ConversationEditTarget } from "./product-projection-state.js";
import type { SessionEvent } from "@lcode/contracts";
import type {
  ConversationRow,
  ConversationDelta,
  ToolCallRow,
  SubagentRow,
} from "@lcode/shared/lcode-protocol-v4";
import type { CanonicalOpenSegmentIdentity } from "./event-normalizer.js";

type RowBaseHost = Pick<ProductProjectionState, "nextRowId" | "entityIdByRowId">;

type TurnIdOfHost = Pick<ProductProjectionState, "productTurnIdByRuntimeTurnId" | "currentTurnId">;

type FindRowHost = Pick<ProductProjectionState, "snapshot" | "rowIndexById">;

type FindToolRowHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "toolRowIdByCallId"
>;

type FindSubagentRowHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "subagentRowIdByAgentId"
>;

type OpenAssistantSegmentsHost = Pick<
  ProductProjectionState,
  "streamingTextRowId" | "streamingReasoningRowId" | "messageIdByRowId" | "entityIdByRowId"
>;

type OpenSegmentIdentityHost = Pick<ProductProjectionState, "messageIdByRowId" | "entityIdByRowId">;

type RegisterCanonicalUserRowTargetHost = Pick<
  ProductProjectionState,
  "messageIdByRowId" | "entityIdByRowId" | "editTargetByEntityId"
>;

type RowIdForMessageIdHost = Pick<
  ProductProjectionState,
  "messageIdByRowId" | "outputContinuationRowIdByMessageId"
>;

type RewindAnchorForRowsHost = Pick<ProductProjectionState, "messageIdByRowId">;

export function rowBase(
  host: RowBaseHost,
  event: SessionEvent,
  turnId: string,
  entityId = String(event.id),
) {
  const rowId = host.nextRowId++;
  host.entityIdByRowId.set(rowId, entityId);
  return {
    rowId,
    turnId,
    entityId,
    productTurnId: turnId,
    visibility: "visible" as const,
    createdAt: ms(event),
    createdAtSeq: event.sequenceNumber,
  };
}

export function turnIdOf(host: TurnIdOfHost, event: SessionEvent): string {
  const runtimeTurnId = String(event.turnId ?? host.currentTurnId ?? "turn-unknown");
  // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
  return host.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
}

export function ms(event: SessionEvent): number {
  return event.timestamp.getTime();
}

export function findRow(host: FindRowHost, rowId: number): ConversationRow | undefined {
  const index = host.rowIndexById.get(rowId);
  return index === undefined ? undefined : host.snapshot.rows.window[index];
}

export function updateRowIndexAfterImmutableApply(
  host: FindRowHost,
  previousRowsLength: number,
  deltas: readonly ConversationDelta[],
): void {
  if (deltas.some((delta) => delta.op === "row.removed")) {
    host.rowIndexById = new Map(host.snapshot.rows.window.map((row, index) => [row.rowId, index]));
    return;
  }
  let nextIndex = previousRowsLength;
  for (const delta of deltas) {
    if (delta.op !== "row.appended") continue;
    host.rowIndexById.set(delta.row.rowId, nextIndex);
    nextIndex += 1;
  }
}

export function findToolRow(host: FindToolRowHost, toolCallId: string): ToolCallRow | undefined {
  const rowId = host.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return undefined;
  const row = findRow(host, rowId);
  return row?.kind === "toolCall" ? row : undefined;
}

export function findSubagentRow(
  host: FindSubagentRowHost,
  agentId: string,
): SubagentRow | undefined {
  const rowId = host.subagentRowIdByAgentId.get(agentId);
  if (rowId === undefined) return undefined;
  const row = findRow(host, rowId);
  return row?.kind === "subagent" ? row : undefined;
}

export function openAssistantSegments(
  host: OpenAssistantSegmentsHost,
): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> {
  const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
  const text = openSegmentIdentity(host, host.streamingTextRowId);
  const reasoning = openSegmentIdentity(host, host.streamingReasoningRowId);
  if (text) segments.text = text;
  if (reasoning) segments.reasoning = reasoning;
  return segments;
}

function openSegmentIdentity(
  host: OpenSegmentIdentityHost,
  rowId: number | null,
): CanonicalOpenSegmentIdentity | null {
  if (rowId === null) return null;
  const entityId = host.entityIdByRowId.get(rowId);
  if (!entityId) return null;
  return {
    entityId,
    transcriptMessageId: host.messageIdByRowId.get(rowId) ?? null,
  };
}

/**
 * real-user row 的展示身份与命令身份必须原子登记。
 * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
 * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
 */
export function registerCanonicalUserRowTarget(
  host: RegisterCanonicalUserRowTargetHost,
  rowId: number,
  entityId: string,
  editTarget?: ConversationEditTarget,
): void {
  host.entityIdByRowId.set(rowId, entityId);
  if (!editTarget) return;
  host.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
  host.editTargetByEntityId.set(entityId, editTarget);
}

/** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
export function rowIdForMessageId(host: RowIdForMessageIdHost, messageId: string): number | null {
  const continuationRowId = host.outputContinuationRowIdByMessageId.get(messageId);
  if (continuationRowId !== undefined) return continuationRowId;
  for (const [rowId, mid] of host.messageIdByRowId) {
    if (mid === messageId) return rowId;
  }
  return null;
}

export function rewindAnchorForRows(
  host: RewindAnchorForRowsHost,
  rows: readonly ConversationRow[],
  rowId: number,
): string | null {
  const row = rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return null;
  const turnId = row.turnId;
  for (const [candidateRowId, messageId] of host.messageIdByRowId) {
    const candidate = rows.find((item) => item.rowId === candidateRowId);
    if (candidate && candidate.turnId === turnId) return messageId;
  }
  return null;
}

export function pruneRemovedSubagentIndexes(host: FindSubagentRowHost): void {
  for (const [agentId, rowId] of host.subagentRowIdByAgentId) {
    if (findRow(host, rowId)?.kind === "subagent") continue;
    // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
    // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
    // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
    host.subagentRowIdByAgentId.delete(agentId);
  }
}
