import {
  SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT,
  SESSION_HISTORY_SEARCH_MAX_LIMIT,
  SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_QUERY_MAX_LENGTH,
  SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type MessageWithParts,
  type SessionHistorySearchOutput,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type SessionTranscriptSnapshot,
  type WorkspaceId,
} from "@lcode/contracts";
import {
  SESSION_HISTORY_SEARCH_TASK_TYPES,
  isSessionHistorySearchTaskType,
  projectSessionHistorySearchText,
  rankSessionHistorySearchCandidates,
  type SessionHistorySearchCandidate,
} from "./session-history-search.js";
import { canReadSessionContextFromWorkspace } from "./workspace-session-scope.js";

export interface SessionHistorySearchBounds {
  candidateLimit: number;
  perSessionCharacterLimit: number;
  previewCharacterLimit: number;
  resultLimit: number;
  totalCharacterLimit: number;
  transcriptDataByteLimit: number;
  transcriptMessageRowLimit: number;
  transcriptPartRowLimit: number;
}

export const EXPLICIT_SESSION_HISTORY_SEARCH_BOUNDS: SessionHistorySearchBounds = {
  candidateLimit: SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT,
  perSessionCharacterLimit: SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
  previewCharacterLimit: SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
  resultLimit: SESSION_HISTORY_SEARCH_MAX_LIMIT,
  totalCharacterLimit: SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT,
  transcriptDataByteLimit: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  transcriptMessageRowLimit: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  transcriptPartRowLimit: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
};

export interface SearchSessionHistoryInput {
  abortSignal: AbortSignal;
  bounds?: Partial<SessionHistorySearchBounds>;
  currentSessionId: SessionId;
  query: string;
  requestedLimit: number;
  sessionStore?: SessionStorePort;
  workspaceIdentity?: string;
  workspaceRoot: string;
}

export async function searchSessionHistory(
  input: SearchSessionHistoryInput,
): Promise<SessionHistorySearchOutput> {
  const store = input.sessionStore;
  if (!store) return unavailable("session_store_unavailable");

  const query = input.query.trim().slice(0, SESSION_HISTORY_SEARCH_QUERY_MAX_LENGTH);
  const bounds = normalizeBounds(input.bounds);
  let listed: SessionInfo[];
  try {
    listed = await store.listSessions(buildSessionListInput(input, bounds.candidateLimit));
  } catch (error) {
    if (input.abortSignal.aborted) throw error;
    return unavailable("session_list_failed");
  }

  const workspace = {
    workspaceIdentity: input.workspaceIdentity,
    workspaceRoot: input.workspaceRoot,
  };
  const scoped = listed.filter(
    (session) =>
      session.id !== input.currentSessionId &&
      session.time.archived === undefined &&
      isSessionHistorySearchTaskType(session.taskType) &&
      canReadSessionContextFromWorkspace(session, workspace),
  );
  const sessions = scoped.slice(0, bounds.candidateLimit);
  let truncated =
    listed.length >= storeLookaheadLimit(bounds.candidateLimit) ||
    scoped.length > bounds.candidateLimit;
  let failedSessionCount = 0;
  let projectedCharacterCount = 0;
  let scannedMessageCount = 0;
  let scannedSessionCount = 0;
  let successfulSessionSnapshots = 0;
  const candidates: SessionHistorySearchCandidate[] = [];

  for (const session of sessions) {
    throwIfSessionHistorySearchAborted(input.abortSignal);
    if (projectedCharacterCount >= bounds.totalCharacterLimit) {
      truncated = true;
      break;
    }

    scannedSessionCount += 1;
    let messages: MessageWithParts[];
    let refreshedSession: SessionInfo | null;
    try {
      const snapshot = await readSearchSnapshot(store, session.id, bounds, input.abortSignal);
      messages = snapshot.messages;
      refreshedSession = snapshot.session;
      truncated ||= snapshot.truncated;
    } catch (error) {
      if (input.abortSignal.aborted) throw error;
      failedSessionCount += 1;
      truncated = true;
      continue;
    }
    scannedMessageCount += messages.length;

    throwIfSessionHistorySearchAborted(input.abortSignal);
    if (
      !refreshedSession ||
      refreshedSession.id !== session.id ||
      refreshedSession.id === input.currentSessionId ||
      refreshedSession.time.archived !== undefined ||
      !isSessionHistorySearchTaskType(refreshedSession.taskType) ||
      !canReadSessionContextFromWorkspace(refreshedSession, workspace)
    ) {
      // messages 与 metadata 不是原子快照；并发 rewind/归档/换 scope 后必须 fail closed，
      // 不能把旧边界应用到刚读取的 append-only rows。
      failedSessionCount += 1;
      truncated = true;
      continue;
    }
    successfulSessionSnapshots += 1;
    if (refreshedSession.title.length > SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT) {
      truncated = true;
    }

    const projection = projectSessionHistorySearchText({
      characterLimit: Math.min(
        bounds.perSessionCharacterLimit,
        bounds.totalCharacterLimit - projectedCharacterCount,
      ),
      messages,
      session: refreshedSession,
    });
    projectedCharacterCount += projection.projectedCharacterCount;
    truncated ||= projection.truncated;
    candidates.push({ projection, session: refreshedSession });
  }

  if (sessions.length > 0 && successfulSessionSnapshots === 0) {
    return unavailable("session_messages_failed");
  }
  if (scannedSessionCount < sessions.length) truncated = true;

  const ranked = rankSessionHistorySearchCandidates({
    candidates,
    previewCharacterLimit: bounds.previewCharacterLimit,
    query,
  });
  if (ranked.some((candidate) => candidate.previewTruncated)) truncated = true;
  const resultLimit = clampPositive(input.requestedLimit, bounds.resultLimit);
  if (ranked.length > resultLimit) truncated = true;

  return {
    status: "ok",
    query,
    matches: ranked.slice(0, resultLimit).map((candidate) => ({
      sessionId: candidate.session.id,
      title: candidate.title,
      updatedAt: candidate.session.time.updated,
      preview: candidate.preview,
      score: candidate.score,
    })),
    candidateSessionCount: sessions.length,
    scannedSessionCount,
    scannedMessageCount,
    projectedCharacterCount,
    failedSessionCount,
    truncated,
  };
}

function normalizeBounds(
  input: Partial<SessionHistorySearchBounds> | undefined,
): SessionHistorySearchBounds {
  return {
    candidateLimit: clampPositive(input?.candidateLimit, SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT),
    perSessionCharacterLimit: clampPositive(
      input?.perSessionCharacterLimit,
      SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
    ),
    previewCharacterLimit: clampPositive(
      input?.previewCharacterLimit,
      SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
    ),
    resultLimit: clampPositive(input?.resultLimit, SESSION_HISTORY_SEARCH_MAX_LIMIT),
    totalCharacterLimit: clampPositive(
      input?.totalCharacterLimit,
      SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT,
    ),
    transcriptDataByteLimit: clampPositive(
      input?.transcriptDataByteLimit,
      SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
    ),
    transcriptMessageRowLimit: clampPositive(
      input?.transcriptMessageRowLimit,
      SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
    ),
    transcriptPartRowLimit: clampPositive(
      input?.transcriptPartRowLimit,
      SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
    ),
  };
}

async function readSearchSnapshot(
  store: SessionStorePort,
  sessionID: SessionId,
  bounds: SessionHistorySearchBounds,
  abortSignal: AbortSignal,
): Promise<SessionTranscriptSnapshot> {
  if (store.readTranscriptSnapshot) {
    return store.readTranscriptSnapshot({
      sessionID,
      limits: {
        maxDataBytes: bounds.transcriptDataByteLimit,
        maxMessageRows: bounds.transcriptMessageRowLimit,
        maxPartRows: bounds.transcriptPartRowLimit,
      },
    });
  }

  const messages = await store.messages({ sessionID });
  throwIfSessionHistorySearchAborted(abortSignal);
  const session = await store.getSession(sessionID);
  return {
    session,
    messages,
    loadedMessageCount: messages.length,
    loadedPartCount: messages.reduce((count, message) => count + message.parts.length, 0),
    loadedDataBytes: 0,
    truncated: false,
  };
}

function clampPositive(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function buildSessionListInput(input: SearchSessionHistoryInput, candidateLimit: number) {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  return {
    includeArchived: false,
    limit: storeLookaheadLimit(candidateLimit),
    taskTypes: [...SESSION_HISTORY_SEARCH_TASK_TYPES],
    ...(workspaceIdentity
      ? { workspaceID: workspaceIdentity as WorkspaceId }
      : { directory: input.workspaceRoot, workspaceID: null }),
  };
}

function storeLookaheadLimit(candidateLimit: number): number {
  return candidateLimit + 2;
}

function unavailable(
  reason: Extract<SessionHistorySearchOutput, { status: "unavailable" }>["reason"],
): SessionHistorySearchOutput {
  switch (reason) {
    case "session_store_unavailable":
      return { status: "unavailable", reason, retryable: false };
    case "session_list_failed":
      return { status: "unavailable", reason, retryable: true };
    case "session_messages_failed":
      return { status: "unavailable", reason, retryable: true };
  }
}

function throwIfSessionHistorySearchAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Session history search was cancelled");
  error.name = "AbortError";
  throw error;
}
