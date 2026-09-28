import type { MessageWithParts, SessionInfo } from "@lcode/contracts";
import { activeSessionMessages } from "../agent/session-history-hydrator.js";

/** Project an append-only session transcript onto the compact/rewind branch visible to the model. */
export function activeSessionMessagesForSession(
  messages: MessageWithParts[],
  session: Pick<SessionInfo, "revert">,
): MessageWithParts[] {
  const revert = session.revert;
  // SessionStore 会保留 rewind 丢弃分支；遗漏 revert 边界会让显式读取和搜索重新暴露旧内容。
  // 统一从 SessionInfo 派生投影参数，避免各调用点只裁 compact、漏裁 conversation branch。
  return activeSessionMessages(messages, {
    branchCutAfterMessageId: revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: revert?.createdMessageID,
    rewindKeptMessageIds: revert?.keptMessageIDs,
    rewindTargetMessageId: revert?.targetMessageID,
  });
}
