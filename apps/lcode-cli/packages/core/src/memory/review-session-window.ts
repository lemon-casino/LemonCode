import type { MessageWithParts, SessionInfo, SessionTranscriptWindow } from "@lcode/contracts";
import { isActiveCompactionBoundaryPart } from "../agent/compact-session.js";

/**
 * window缺早期前缀不等于缺当前turn。只消费能证明属于活动分支的连续后缀，
 * 不把范围外的target/kept缺席误判为整个历史失效，也不猜缺失cut的顺序。
 */
export function activeReviewWindowMessages(
  window: SessionTranscriptWindow,
  session: SessionInfo,
  boundaryMessageId: string,
): MessageWithParts[] | undefined {
  if (
    !window.boundaryFound ||
    window.throughMessageID !== boundaryMessageId ||
    window.truncated ||
    typeof window.prefixTruncated !== "boolean" ||
    window.messages.at(-1)?.info.id !== boundaryMessageId
  )
    return undefined;
  const { messages } = window;
  const revert = session.revert;
  let active = messages;
  if (revert) {
    const hasBranch = Boolean(
      revert.targetMessageID ||
      revert.createdMessageID ||
      revert.branchCutAfterMessageID ||
      revert.keptMessageIDs,
    );
    if (hasBranch && !revert.targetMessageID) return undefined;
    if (revert.targetMessageID) {
      if (revert.branchCutAfterMessageID) {
        const cut = messages.findIndex(
          (message) => message.info.id === revert.branchCutAfterMessageID,
        );
        // cut在窗内即足以证明其后的新分支，不要求所有旧kept/target也落入窗口。
        if (cut < 0) return undefined;
        active = messages.slice(cut + 1);
      } else if (revert.createdMessageID) {
        const created = messages.findIndex(
          (message) => message.info.id === revert.createdMessageID,
        );
        if (created < 0) return undefined;
        active = messages.slice(created);
      } else {
        const kept = new Set<string>(revert.keptMessageIDs ?? []);
        if (!kept.has(boundaryMessageId)) return undefined;
        // 仅当目标尾部连续且每条明确在kept中才可使用，不能拼接不相邻片段伪造完整turn。
        let start = messages.length;
        while (start > 0 && kept.has(messages[start - 1]!.info.id)) start -= 1;
        active = messages.slice(start);
      }
    }
  }
  if (active.at(-1)?.info.id !== boundaryMessageId) return undefined;
  const compactIndex = active.findLastIndex((message) =>
    message.parts.some(isActiveCompactionBoundaryPart),
  );
  // compact summary是派生文本。窗口不补齐preserved prefix；必须等summary之后新的真实用户turn。
  if (compactIndex >= 0) active = active.slice(compactIndex + 1);
  return active.filter((message) => !isDerivedSummary(message));
}

export function isDerivedSummary(message: MessageWithParts): boolean {
  if (message.parts.some((part) => part.type === "compaction")) return true;
  return message.info.role === "assistant"
    ? message.info.summary === true
    : message.info.summary !== undefined;
}
