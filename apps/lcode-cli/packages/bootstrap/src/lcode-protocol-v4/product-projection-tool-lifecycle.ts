// 工具终态兜底与 foreground 派生索引维护，始终复核权威 row。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { SessionEvent } from "@lcode/contracts";
import type { ToolCallRow, ConversationDelta } from "@lcode/shared/lcode-protocol-v4";
import { findToolRow, ms, pruneRemovedSubagentIndexes } from "./product-projection-rows.js";
import { takePendingStreamingToolInput } from "./product-projection-tool-stream.js";

type CloseOpenToolRowsHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "toolRowIdByCallId"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
>;

type UpdateToolIndexesAfterDeltasHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "toolRowIdByCallId"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
  | "subagentRowIdByAgentId"
>;

// turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
// `only` 让 stream recovery 只收口未定稿的那一部分。
export function closeOpenToolRows(
  host: CloseOpenToolRowsHost,
  event: SessionEvent,
  status: "cancelled" | "error",
  only?: (row: ToolCallRow) => boolean,
): ConversationDelta[] {
  if (host.openForegroundToolCallIds.size === 0) return [];
  const openRows: ToolCallRow[] = [];
  for (const toolCallId of host.openForegroundToolCallIds) {
    const row = findToolRow(host, toolCallId);
    // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
    if (!row || !isOpenForegroundToolRow(row)) continue;
    if (only && !only(row)) continue;
    openRows.push(row);
  }
  if (openRows.length === 0) return [];
  // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
  if (openRows.length > 1) {
    openRows.sort((left, right) => left.rowId - right.rowId);
  }
  const deltas: ConversationDelta[] = [];
  const closedToolCallIds = new Set<string>();
  for (const row of openRows) {
    const next: ToolCallRow = {
      ...row,
      status,
      inputText: `${row.inputText ?? ""}${takePendingStreamingToolInput(host, row.toolCallId)}`,
      endedAt: ms(event),
    };
    delete next.approvalInteractionId;
    if (status === "error") {
      // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
      // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
      next.error = {
        code: "fault.runtime.toolLifecycleIncomplete",
        message: "Tool call ended without a terminal event.",
      };
    } else {
      delete next.error;
    }
    closedToolCallIds.add(row.toolCallId);
    deltas.push({ op: "row.upserted", row: next });
  }

  const pendingInteractions = host.snapshot.pendingInteractions.filter(
    (interaction) =>
      !(
        (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
        typeof interaction.payload.toolCallId === "string" &&
        closedToolCallIds.has(interaction.payload.toolCallId)
      ),
  );
  if (pendingInteractions.length !== host.snapshot.pendingInteractions.length) {
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  return deltas;
}

function isOpenForegroundToolRow(row: ToolCallRow): boolean {
  return (
    row.backgrounded !== true &&
    (row.status === "inputStreaming" ||
      row.status === "pendingApproval" ||
      row.status === "running")
  );
}

export function updateToolIndexesAfterDeltas(
  host: UpdateToolIndexesAfterDeltasHost,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      if (delta.row.kind !== "toolCall") continue;
      if (isOpenForegroundToolRow(delta.row)) {
        host.openForegroundToolCallIds.add(delta.row.toolCallId);
      } else {
        host.openForegroundToolCallIds.delete(delta.row.toolCallId);
      }
      continue;
    }
    if (delta.op !== "row.removed") continue;
    for (const [toolCallId, rowId] of host.toolRowIdByCallId) {
      if (rowId < delta.fromRowId) continue;
      // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
      // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
      host.toolRowIdByCallId.delete(toolCallId);
      host.openForegroundToolCallIds.delete(toolCallId);
      host.fileToolInputPreviewByCallId.delete(toolCallId);
    }
    pruneRemovedSubagentIndexes(host);
  }
}
