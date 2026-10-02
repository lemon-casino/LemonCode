import {
  MEMORY_REVIEW_TOOL_NAME,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type MessageId,
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type SessionTranscriptSnapshot,
  type SessionTranscriptWindow,
  type WorkspaceId,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import { isActiveCompactionBoundaryPart } from "../agent/compact-session.js";
import { activeSessionMessagesForSession } from "../session-context/active-session-messages.js";
import { messagesAfterLastMemoryReviewTurn } from "./extraction.js";
import { memoryReviewProfile } from "./review-profile.js";
import { activeReviewWindowMessages, isDerivedSummary } from "./review-session-window.js";
import {
  isSessionHistorySearchTaskType,
  projectSessionHistorySearchText,
  SESSION_HISTORY_SEARCH_TASK_TYPES,
} from "../session-context/session-history-search.js";
import { canReadSessionContextFromWorkspace } from "../session-context/workspace-session-scope.js";
import {
  createReviewSource,
  MemoryReviewError,
  reviewHash,
  reviewIO,
  type FrozenReviewSource,
} from "./review-common.js";

const SESSION_LIST_LOOKAHEAD = 2;
const SESSION_REFERENCE_CHARACTER_LIMIT = 256;
const REAL_USER_PROBE_CHARACTER_LIMIT = 1;
const SNAPSHOT_LIMITS = {
  maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
};

export async function validateReviewSessionScope(
  context: ToolExecutionContext,
): Promise<SessionInfo> {
  const current = await reviewIO(context, () =>
    context.sessionStore!.getSession(context.sessionId),
  );
  assertSessionScope(current, context.sessionId, context);
  return current;
}

export async function collectReviewSessionEvidence(context: ToolExecutionContext): Promise<{
  materials: FrozenReviewSource[];
  partial: boolean;
}> {
  const profile = memoryReviewProfile(context);
  const current = await validateReviewSessionScope(context);
  if (context.reviewMode === "incremental") {
    const material = await readReviewSessionEvidence(
      current.id,
      profile.sessionCharacterLimit,
      context,
      context.reviewBoundary!.messageId,
      "latest-turn",
    );
    return { materials: material ? [material] : [], partial: material?.partial ?? true };
  }
  const workspaceID = context.workspaceIdentity?.trim();
  const listed = await reviewIO(context, () =>
    context.sessionStore!.listSessions({
      includeArchived: false,
      taskTypes: [...SESSION_HISTORY_SEARCH_TASK_TYPES],
      limit: profile.sessionLimit + SESSION_LIST_LOOKAHEAD,
      ...(workspaceID
        ? { workspaceID: workspaceID as WorkspaceId }
        : { directory: context.workspaceRoot, workspaceID: null }),
    }),
  );
  const unique = new Map<SessionId, SessionInfo>([[current.id, current]]);
  for (const session of listed.slice(0, profile.sessionLimit + SESSION_LIST_LOOKAHEAD)) {
    if (isScopedSession(session, context)) unique.set(session.id, session);
  }
  let partial =
    listed.length >= profile.sessionLimit + SESSION_LIST_LOOKAHEAD ||
    unique.size > profile.sessionLimit;
  const materials: FrozenReviewSource[] = [];
  let characters = 0;
  for (const session of [...unique.values()].slice(0, profile.sessionLimit)) {
    const characterLimit = Math.min(
      profile.sessionCharacterLimit,
      profile.sessionTotalCharacterLimit - characters,
    );
    if (characterLimit <= 0) {
      partial = true;
      break;
    }
    const boundary =
      context.reviewBoundary?.sessionId === context.sessionId && session.id === context.sessionId
        ? context.reviewBoundary.messageId
        : undefined;
    const material = await readReviewSessionEvidence(session.id, characterLimit, context, boundary);
    if (!material) {
      partial = true;
      continue;
    }
    partial ||= material.partial;
    characters += material.content.length;
    materials.push(material);
  }
  return { materials, partial };
}

export async function readReviewSessionEvidence(
  sessionId: string,
  characterLimit: number,
  context: ToolExecutionContext,
  boundaryMessageId?: string,
  projection?: "latest-turn",
): Promise<FrozenReviewSource | undefined> {
  const id = sessionId as SessionId;
  const before = await reviewIO(context, () => context.sessionStore!.getSession(id));
  assertSessionScope(before, id, context);
  const beforeVersion = selectionVersion(before);
  let window: SessionTranscriptWindow | undefined;
  let snapshot: SessionTranscriptSnapshot;
  if (projection === "latest-turn") {
    if (!context.sessionStore!.readTranscriptWindow || !boundaryMessageId)
      throw new MemoryReviewError("unavailable");
    window = await reviewIO(context, () =>
      context.sessionStore!.readTranscriptWindow!({
        sessionID: id,
        throughMessageID: boundaryMessageId as MessageId,
        limits: { ...SNAPSHOT_LIMITS },
      }),
    );
    snapshot = window;
  } else {
    if (!context.sessionStore!.readTranscriptSnapshot) throw new MemoryReviewError("unavailable");
    snapshot = await reviewIO(context, () =>
      context.sessionStore!.readTranscriptSnapshot!({
        sessionID: id,
        limits: { ...SNAPSHOT_LIMITS },
      }),
    );
  }
  assertSessionScope(snapshot.session, id, context);
  const after = await reviewIO(context, () => context.sessionStore!.getSession(id));
  assertSessionScope(after, id, context);
  if (
    beforeVersion !== selectionVersion(snapshot.session) ||
    beforeVersion !== selectionVersion(after)
  ) {
    throw new MemoryReviewError("stale_source");
  }
  assertSnapshotBudget(snapshot, id);
  // storage snapshot 是前缀，不是有效分支的完整窗口。尾部未知时可能漏掉 compact，
  // 所以不把旧前缀当事实；字符投影截断则安全，因为分支已经由完整有界快照决定。
  if (snapshot.truncated) return undefined;
  let activeMessages: MessageWithParts[] | undefined;
  if (window)
    activeMessages = activeReviewWindowMessages(window, snapshot.session, boundaryMessageId!);
  else {
    assertBranchSelectionAvailable(snapshot.messages, snapshot.session);
    activeMessages = activeSessionMessagesForSession(snapshot.messages, snapshot.session);
  }
  if (!activeMessages) return undefined;
  let boundedMessages = activeMessages;
  if (boundaryMessageId) {
    const boundaryIndex = activeMessages.findIndex(
      (message) => message.info.id === boundaryMessageId,
    );
    if (boundaryIndex < 0) throw new MemoryReviewError("stale_source");
    boundedMessages = activeMessages.slice(0, boundaryIndex + 1);
  } else if (projection) throw new MemoryReviewError("stale_source");
  const projectionSession = { ...snapshot.session, revert: undefined };
  const isRealUser = (message: MessageWithParts) =>
    message.info.role === "user" &&
    !isDerivedSummary(message) &&
    projectSessionHistorySearchText({
      messages: [message],
      session: projectionSession,
      characterLimit: REAL_USER_PROBE_CHARACTER_LIMIT,
    }).searchText.length > 0;
  // 旧notice可能缺synthetic标志；先按统一可见性排除，不能让它重新开启未采用提案的assistant后缀。
  const trustedBoundaries = boundedMessages
    .filter((message) => message.info.role !== "user" || isRealUser(message))
    .map((message) => {
      // 当前create尚未形成提案，不能把自己的running工具当旧复盘轮剔除真实用户请求。
      // 只豁免可信执行context的精确call；完成项、其他call和其他session仍保持隔离。
      if (id !== context.sessionId) return message;
      return {
        ...message,
        parts: message.parts.filter(
          (part) =>
            !(
              part.type === "tool" &&
              part.tool === MEMORY_REVIEW_TOOL_NAME &&
              part.callID === context.toolCallId &&
              (part.state.status === "pending" || part.state.status === "running")
            ),
        ),
      };
    });
  let evidenceMessages = messagesAfterLastMemoryReviewTurn(trustedBoundaries);
  if (projection === "latest-turn") {
    const lastUserIndex = evidenceMessages.findLastIndex(isRealUser);
    if (lastUserIndex < 0) return undefined;
    evidenceMessages = evidenceMessages.slice(lastUserIndex);
  }
  // SessionInfo 没有独立 synthetic 标志；有效后缀没有真实用户文字就不接受assistant单方事实。
  const realUserText = projectSessionHistorySearchText({
    messages: evidenceMessages.filter((message) => message.info.role === "user"),
    session: projectionSession,
    characterLimit: REAL_USER_PROBE_CHARACTER_LIMIT,
  });
  if (!realUserText.searchText) return undefined;
  const textProjection = projectSessionHistorySearchText({
    messages: [...evidenceMessages],
    session: projectionSession,
    characterLimit,
  });
  if (!textProjection.searchText) return undefined;
  const source = createReviewSource({
    context,
    kind: "session",
    reference: id,
    characterLimit,
    boundaryMessageId,
    projection,
    material: {
      text: textProjection.searchText,
      selection: selectionFields(snapshot.session),
      compact: compactSelection(boundedMessages),
    },
  });
  return {
    source,
    content: textProjection.searchText,
    partial:
      textProjection.truncated ||
      window?.prefixTruncated === true ||
      evidenceMessages.length !== activeMessages.length,
  };
}

function isScopedSession(session: SessionInfo, context: ToolExecutionContext): boolean {
  return (
    typeof session.id === "string" &&
    session.id.length > 0 &&
    session.id.length <= SESSION_REFERENCE_CHARACTER_LIMIT &&
    session.time.archived === undefined &&
    isSessionHistorySearchTaskType(session.taskType) &&
    (!session.parentID || session.taskType === "fork") &&
    canReadSessionContextFromWorkspace(session, context)
  );
}

function assertSessionScope(
  session: SessionInfo | null,
  id: SessionId,
  context: ToolExecutionContext,
): asserts session is SessionInfo {
  if (!session || session.id !== id || !isScopedSession(session, context)) {
    throw new MemoryReviewError("source_unavailable");
  }
}

function selectionFields(session: SessionInfo): unknown {
  const revert = session.revert;
  return {
    taskType: session.taskType,
    parentID: session.parentID,
    revert: revert
      ? {
          messageID: revert.messageID,
          partID: revert.partID,
          kind: revert.kind,
          scope: revert.scope,
          targetMessageID: revert.targetMessageID,
          createdMessageID: revert.createdMessageID,
          keptMessageIDs: revert.keptMessageIDs,
          branchCutAfterMessageID: revert.branchCutAfterMessageID,
          branchGeneration: revert.branchGeneration,
        }
      : null,
  };
}

function selectionVersion(session: SessionInfo): string {
  return reviewHash(selectionFields(session));
}

function assertSnapshotBudget(snapshot: SessionTranscriptSnapshot, id: SessionId): void {
  const partCount = snapshot.messages.reduce((count, message) => count + message.parts.length, 0);
  if (
    snapshot.messages.length > SNAPSHOT_LIMITS.maxMessageRows ||
    partCount > SNAPSHOT_LIMITS.maxPartRows ||
    !Number.isFinite(snapshot.loadedDataBytes) ||
    snapshot.loadedDataBytes < 0 ||
    snapshot.loadedDataBytes > SNAPSHOT_LIMITS.maxDataBytes ||
    Buffer.byteLength(JSON.stringify(snapshot.messages)) > SNAPSHOT_LIMITS.maxDataBytes
  ) {
    throw new MemoryReviewError("budget_exceeded");
  }
  if (
    snapshot.messages.some(
      (message) =>
        message.info.sessionID !== id ||
        message.parts.some((part) => part.sessionID !== id || part.messageID !== message.info.id),
    )
  ) {
    throw new MemoryReviewError("source_unavailable");
  }
}

function assertBranchSelectionAvailable(messages: MessageWithParts[], session: SessionInfo): void {
  const revert = session.revert;
  if (!revert) return;
  const ids = new Set(messages.map((message) => message.info.id));
  const anchors = [
    revert.targetMessageID,
    revert.createdMessageID,
    revert.branchCutAfterMessageID,
    ...(revert.keptMessageIDs ?? []),
  ].filter((value) => value !== undefined);
  // 既有投影兼容旧数据时会忽略不存在的 target；复盘不可据此放开 discarded 分支。
  if (
    anchors.some((id) => !ids.has(id)) ||
    (!revert.targetMessageID &&
      (revert.branchCutAfterMessageID || revert.keptMessageIDs || revert.createdMessageID))
  ) {
    throw new MemoryReviewError("source_unavailable");
  }
}

function compactSelection(messages: MessageWithParts[]): unknown[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "compaction" || !isActiveCompactionBoundaryPart(part)) return [];
      return [
        {
          messageID: message.info.id,
          partID: part.id,
          preservedSegment: part.compactBoundary?.preservedSegment,
          lastSummarizedMessageId: part.compactBoundary?.lastSummarizedMessageId,
          summaryMessageIds: part.compactBoundary?.summaryMessageIds,
        },
      ];
    }),
  );
}
