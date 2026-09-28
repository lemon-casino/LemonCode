import {
  executionOutputPreviewSchema,
  type ConversationDelta,
  type ToolCallRow,
} from "@lcode/shared/lcode-protocol-v4";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallProgressPayload,
  type ToolCallStartedPayload,
} from "@lcode/contracts";

/** 进度只能更新已运行的 Bash，不创建行、不把终态或后台任务复活。 */
export function projectToolActivity(
  event: SessionEvent,
  row: ToolCallRow | undefined,
): ConversationDelta[] {
  if (!row) return [];
  if (event.type === SessionEventType.ToolCallStarted) {
    const payload = event.payload as ToolCallStartedPayload;
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          status: "running",
          startedAt: event.timestamp.getTime(),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
    ];
  }
  if (row.toolName !== "Bash" || row.status !== "running" || row.backgrounded) return [];
  const parsed = executionOutputPreviewSchema.safeParse(
    (event.payload as ToolCallProgressPayload).outputPreview,
  );
  if (!parsed.success) return [];
  return [{ op: "row.upserted", row: { ...row, outputPreview: parsed.data } }];
}

/** 统一在投影事务中清掉预览，涵盖 result/error、Stop、转后台与轮次收口。 */
export function clearSettledOutputPreviews(deltas: ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (
      (delta.op !== "row.upserted" && delta.op !== "row.appended") ||
      delta.row.kind !== "toolCall" ||
      !delta.row.outputPreview ||
      (delta.row.status === "running" && !delta.row.backgrounded)
    )
      return delta;
    const { outputPreview: _preview, ...row } = delta.row;
    return { ...delta, row };
  });
}
