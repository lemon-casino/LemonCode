import type { CompactBoundaryPayload } from "./index.js";
import type { MessagePart, MessageWithParts } from "../interfaces/session-store/transcript.js";
import type { MessageId } from "../interfaces/shared.js";
import { selectActiveConversationBranch } from "../rewind/index.js";

export interface ActiveSessionTranscriptOptions {
  branchCutAfterMessageId?: MessageId;
  includeCompactPreservedSegment?: boolean;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}
export function isActiveCompactionBoundaryPart(part: MessagePart): boolean {
  return part.type === "compaction" && (Boolean(part.compactBoundary) || !part.timelineStatus);
}
export function isCompactPreservableSessionMessage(message: MessageWithParts): boolean {
  if (
    message.info.semantics?.providerVisibility === "hidden" ||
    message.parts.some((part) => part.type === "compaction")
  )
    return false;
  return message.info.role !== "assistant" || !message.info.error;
}
function boundaryFromMessage(message: MessageWithParts): CompactBoundaryPayload | undefined {
  for (const part of message.parts)
    if (part.type === "compaction" && part.compactBoundary) return part.compactBoundary;
  return undefined;
}
export function compactActiveSessionMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
  includePreservedSegment: boolean,
): MessageWithParts[] {
  const active = messages.slice(boundaryIndex);
  const boundary = boundaryFromMessage(messages[boundaryIndex]!);
  if (!includePreservedSegment || !boundary?.preservedSegment) return active;
  const segment = boundary.preservedSegment;
  const head = messages.findIndex((message) => message.info.id === segment.headMessageId);
  const tail = messages.findIndex((message) => message.info.id === segment.tailMessageId);
  if (head < 0 || tail < head || tail >= boundaryIndex) return active;
  const preserved = messages
    .slice(head, tail + 1)
    .filter(isCompactPreservableSessionMessage)
    .map(
      (message): MessageWithParts =>
        message.info.role !== "assistant"
          ? message
          : {
              ...message,
              info: {
                ...message.info,
                tokens: {
                  ...message.info.tokens,
                  total: 0,
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            },
    );
  const anchor = active.findIndex((message) => message.info.id === segment.anchorMessageId);
  const insert = anchor >= 0 ? anchor + 1 : 1;
  return [...active.slice(0, insert), ...preserved, ...active.slice(insert)];
}
/** The single compact/rewind projection for runtime hydration, scoped context and capsule transactions. */
export function selectActiveSessionTranscript(
  messages: MessageWithParts[],
  options: ActiveSessionTranscriptOptions = {},
): MessageWithParts[] {
  const lastCompactIndex = (records: MessageWithParts[]) =>
    records.findLastIndex((message) => message.parts.some(isActiveCompactionBoundaryPart));
  if (!options.branchCutAfterMessageId) {
    const index = lastCompactIndex(messages);
    const active =
      index >= 0
        ? compactActiveSessionMessages(
            messages,
            index,
            options.includeCompactPreservedSegment !== false,
          )
        : messages;
    if (options.rewindKeptMessageIds && index >= 0) {
      const postCompactIds = new Set(messages.slice(index).map((message) => message.info.id));
      if (!options.rewindKeptMessageIds.some((id) => postCompactIds.has(id))) return active;
    }
    return selectActiveConversationBranch(active, options);
  }
  const branch = selectActiveConversationBranch(messages, options);
  const index = lastCompactIndex(branch);
  return index >= 0
    ? compactActiveSessionMessages(branch, index, options.includeCompactPreservedSegment !== false)
    : branch;
}
