// 流式工具输入的开行、节流预览与定稿；缓存仍属于原投影字段。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { SessionEvent } from "@lcode/contracts";
import type { CanonicalModelStream } from "./event-normalizer.js";
import type { ConversationDelta, ToolCallRow } from "@lcode/shared/lcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import { rowBase, turnIdOf, ms, findToolRow } from "./product-projection-rows.js";
import {
  isLCodeFileStreamingToolInputPreviewTool,
  LCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
} from "@lcode/shared";
import { stringifyToolInput } from "./product-projection-tool-payloads.js";

type OpenToolRowHost = Pick<
  ProductProjectionState,
  | "nextRowId"
  | "toolRowIdByCallId"
  | "fileToolInputPreviewByCallId"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

type AppendStreamingToolInputHost = Pick<
  ProductProjectionState,
  "toolRowIdByCallId" | "fileToolInputPreviewByCallId"
>;

type TakePendingStreamingToolInputHost = Pick<
  ProductProjectionState,
  "fileToolInputPreviewByCallId"
>;

type FinalizeStreamingToolInputHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "toolRowIdByCallId"
  | "fileToolInputPreviewByCallId"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

// ── tool call 状态机 ──

export function openToolRow(
  host: OpenToolRowHost,
  event: SessionEvent,
  payload: CanonicalModelStream,
  entityId?: string,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (
    toolCallId === "" ||
    shouldHideInvalidToolCallFromProduct(payload.toolName) ||
    host.toolRowIdByCallId.has(toolCallId)
  ) {
    return [];
  }
  const row: ToolCallRow = {
    ...rowBase(host, event, turnIdOf(host, event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText: "",
  };
  host.toolRowIdByCallId.set(toolCallId, row.rowId);
  if (isLCodeFileStreamingToolInputPreviewTool(row.toolName)) {
    host.fileToolInputPreviewByCallId.set(toolCallId, {
      lastPublishedAt: null,
      pendingAppend: "",
    });
  }
  if (entityId) host.entityIdByRowId.set(row.rowId, entityId);
  return [{ op: "row.appended", row }];
}

export function appendStreamingToolInput(
  host: AppendStreamingToolInputHost,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  const rowId = host.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return [];
  const state = host.fileToolInputPreviewByCallId.get(toolCallId);
  if (!state) {
    return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
  }

  state.pendingAppend += payload.delta;
  const now = ms(event);
  if (
    state.lastPublishedAt !== null &&
    now - state.lastPublishedAt < LCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
  ) {
    return [];
  }

  const append = state.pendingAppend;
  state.pendingAppend = "";
  state.lastPublishedAt = now;
  return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function flushStreamingToolInput(
  host: AppendStreamingToolInputHost,
  toolCallId: string,
): ConversationDelta[] {
  const append = takePendingStreamingToolInput(host, toolCallId);
  if (append === "") return [];
  const rowId = host.toolRowIdByCallId.get(toolCallId);
  return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function takePendingStreamingToolInput(
  host: TakePendingStreamingToolInputHost,
  toolCallId: string,
): string {
  const state = host.fileToolInputPreviewByCallId.get(toolCallId);
  host.fileToolInputPreviewByCallId.delete(toolCallId);
  return state?.pendingAppend ?? "";
}

export function finalizeStreamingToolInput(
  host: FinalizeStreamingToolInputHost,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (toolCallId === "") return [];
  host.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const existing = findToolRow(host, toolCallId);
  if (existing) {
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantResponseId
            ? { assistantResponseId: payload.assistantResponseId }
            : {}),
          toolName: existing.toolName || payload.toolName || "",
          inputText,
          input: payload.input,
        },
      },
    ];
  }

  const row: ToolCallRow = {
    ...rowBase(host, event, turnIdOf(host, event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText,
    input: payload.input,
  };
  host.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }];
}
