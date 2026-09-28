import type { SessionStorePort } from "@lcode/contracts";
import type { CommandAck } from "@lcode/shared/lcode-protocol-v4";
import { queueItemIdForCommand } from "./command-inbox.js";

/**
 * createSession 使用 global command bucket，但 firstInput 的 durable fact 落在新 session。
 * 通过全局唯一 queue item id 找回真实 session，闭合 ACK 丢失/CLI restart 的查重路径。
 */
export async function lookupGlobalCreateSessionCommand(
  store: SessionStorePort | undefined,
  commandId: string,
): Promise<CommandAck | null> {
  const record = await store?.getSessionInputById?.(queueItemIdForCommand(commandId));
  if (
    !record ||
    record.payload.sourceCommandType !== "createSession" ||
    (record.payload.conversationInputIntent as { sourceCommandId?: unknown } | undefined)
      ?.sourceCommandId !== commandId
  ) {
    return null;
  }
  if (record.status === "promoted") {
    return {
      commandId,
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "createSession", sessionId: String(record.sessionID) },
    };
  }
  if (record.status === "admitted") {
    await store?.settleSessionInput?.({
      id: record.id,
      sessionID: record.sessionID,
      status: "discarded",
      reason: "session_resumed",
    });
    return {
      commandId,
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      message: "Input was discarded when the CLI restarted; confirm before resending.",
      revisionAtDecision: 0,
    };
  }
  const reasonCode =
    record.status === "discarded" && record.statusReason === "session_resumed"
      ? "fault.command.inputDiscardedOnRestart"
      : record.statusReason?.startsWith("fault.") ||
          record.statusReason?.startsWith("proto.") ||
          record.statusReason?.startsWith("guard.")
        ? record.statusReason
        : "fault.command.inputCancelled";
  return {
    commandId,
    status: "failed",
    reasonCode,
    revisionAtDecision: 0,
  };
}
