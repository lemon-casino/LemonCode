// 正文/思考流的行生命周期、Continue 连续段和 publisher 上界估算。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import {
  type SessionEvent,
  SessionEventType,
  type ModelStreamingPayload,
  type AssistantFeedbackUpdatedPayload,
} from "@lcode/contracts";
import { isRunning } from "./product-projection-session.js";
import { ms, findRow, turnIdOf, rowBase } from "./product-projection-rows.js";
import { LCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS } from "@lcode/shared";
import type { CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import type {
  ConversationDelta,
  AssistantTextRow,
  ReasoningRow,
} from "@lcode/shared/lcode-protocol-v4";
import {
  openToolRow,
  appendStreamingToolInput,
  flushStreamingToolInput,
  finalizeStreamingToolInput,
} from "./product-projection-tool-stream.js";

type EstablishedStreamingAppendHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "toolRowIdByCallId"
  | "fileToolInputPreviewByCallId"
>;

type ModelStreamingHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "outputContinuationTextRowId"
  | "toolRowIdByCallId"
  | "fileToolInputPreviewByCallId"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
  | "droppedContentStreamEventCount"
>;

type OpenTextRowHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingTextRowId"
  | "outputContinuationTextRowId"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

type CloseTextRowHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "streamingTextRowId"
>;

type AssistantFeedbackUpdatedHost = Pick<ProductProjectionState, "snapshot">;

type OpenReasoningRowHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingReasoningRowId"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

type CloseReasoningRowHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "streamingReasoningRowId"
>;

type CloseStreamingRowsHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "streamingTextRowId" | "streamingReasoningRowId"
>;

/** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */
export function establishedStreamingAppend(
  host: EstablishedStreamingAppendHost,
  event: SessionEvent,
): string | null {
  if (event.type !== SessionEventType.ModelStreaming || !isRunning(host)) return null;
  const payload = event.payload as ModelStreamingPayload;
  if (payload.kind === "text_delta" && host.streamingTextRowId !== null) return payload.delta;
  if (payload.kind === "reasoning_delta" && host.streamingReasoningRowId !== null) {
    return payload.delta;
  }
  if (
    payload.kind === "tool_input_delta" &&
    host.toolRowIdByCallId.has(String(payload.toolCallId))
  ) {
    const state = host.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
    if (state) {
      if (
        state.lastPublishedAt !== null &&
        ms(event) - state.lastPublishedAt < LCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
      ) {
        return "";
      }
      // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
      return `${state.pendingAppend}${payload.delta}`;
    }
    return payload.delta;
  }
  return null;
}

export function onModelStreaming(
  host: ModelStreamingHost,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const event = fact.event;
  // 迟到终态不复活：非运行期到达的流式事件一律拒收。
  // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
  // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
  // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
  // 下次订阅强制重新 hydration 从持久事实补齐。
  if (!isRunning(host)) {
    const dropped = fact.stream;
    if (
      dropped.kind === "text_start" ||
      dropped.kind === "text_delta" ||
      dropped.kind === "reasoning_start" ||
      dropped.kind === "reasoning_delta"
    ) {
      host.droppedContentStreamEventCount += 1;
    }
    return [];
  }
  const payload = fact.stream;
  switch (payload.kind) {
    case "text_start":
      return openTextRow(host, event, fact);
    case "text_delta": {
      const open = host.streamingTextRowId === null ? openTextRow(host, event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: host.streamingTextRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "text_end":
      return closeTextRow(host, "complete");
    case "reasoning_start":
      return openReasoningRow(host, event, fact);
    case "reasoning_delta": {
      const open = host.streamingReasoningRowId === null ? openReasoningRow(host, event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: host.streamingReasoningRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "reasoning_end":
      return closeReasoningRow(host);
    case "tool_input_start":
      return openToolRow(host, event, payload, fact.entityId);
    case "tool_input_delta": {
      return appendStreamingToolInput(host, event, payload);
    }
    case "tool_input_end":
      return flushStreamingToolInput(host, String(payload.toolCallId ?? ""));
    case "tool_call":
      return finalizeStreamingToolInput(host, event, payload);
    default:
      return [];
  }
}

function openTextRow(
  host: OpenTextRowHost,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = closeTextRow(host, "complete");
  const continuationRowId = host.outputContinuationTextRowId;
  host.outputContinuationTextRowId = null;
  const continuationRow = continuationRowId === null ? undefined : findRow(host, continuationRowId);
  const currentTurnId = turnIdOf(host, event);
  const lastVisibleRow = host.snapshot.rows.window.at(-1);
  if (
    continuationRow?.kind === "assistantText" &&
    continuationRow.turnId === currentTurnId &&
    lastVisibleRow?.rowId === continuationRow.rowId
  ) {
    // runtime 的 output-token Continue 会为每次 provider 请求创建新的
    // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
    // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
    // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
    const {
      actions: _actions,
      assistantResponseId: _assistantResponseId,
      feedback: _feedback,
      ...continuedBase
    } = continuationRow;
    const row: AssistantTextRow = {
      ...continuedBase,
      entityId: fact.entityId,
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      state: "streaming",
    };
    host.streamingTextRowId = row.rowId;
    host.entityIdByRowId.set(row.rowId, fact.entityId);
    const previousMessageId = host.messageIdByRowId.get(row.rowId);
    if (previousMessageId) {
      host.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
    }
    if (fact.transcriptMessageId) {
      host.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.upserted", row }];
  }

  // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
  const row: AssistantTextRow = {
    ...rowBase(host, event, turnIdOf(host, event), fact.entityId),
    kind: "assistantText",
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  host.streamingTextRowId = row.rowId;
  host.entityIdByRowId.set(row.rowId, fact.entityId);
  // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
  if (fact.transcriptMessageId) {
    host.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
  }
  return [...close, { op: "row.appended", row }];
}

function closeTextRow(
  host: CloseTextRowHost,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  if (host.streamingTextRowId === null) return [];
  const row = findRow(host, host.streamingTextRowId);
  host.streamingTextRowId = null;
  if (row?.kind !== "assistantText") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function onAssistantFeedbackUpdated(
  host: AssistantFeedbackUpdatedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as AssistantFeedbackUpdatedPayload;
  const row = host.snapshot.rows.window.find(
    (candidate): candidate is AssistantTextRow =>
      candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  if (payload.feedback === null) {
    if (row.feedback === undefined) return [];
    const { feedback: _removedFeedback, ...withoutFeedback } = row;
    return [{ op: "row.upserted", row: withoutFeedback }];
  }
  if (row.feedback === payload.feedback) return [];
  return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
}

function openReasoningRow(
  host: OpenReasoningRowHost,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = closeReasoningRow(host);
  const row: ReasoningRow = {
    ...rowBase(host, event, turnIdOf(host, event), fact.entityId),
    kind: "reasoning",
    // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
    // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  host.streamingReasoningRowId = row.rowId;
  host.entityIdByRowId.set(row.rowId, fact.entityId);
  return [...close, { op: "row.appended", row }];
}

function closeReasoningRow(
  host: CloseReasoningRowHost,
  state: "complete" | "interrupted" = "complete",
): ConversationDelta[] {
  if (host.streamingReasoningRowId === null) return [];
  const row = findRow(host, host.streamingReasoningRowId);
  host.streamingReasoningRowId = null;
  if (row?.kind !== "reasoning") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function closeStreamingRows(
  host: CloseStreamingRowsHost,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  return [...closeTextRow(host, state), ...closeReasoningRow(host, state)];
}
