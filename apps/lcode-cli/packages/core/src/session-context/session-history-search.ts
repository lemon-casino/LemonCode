import {
  SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT,
  type MessageWithParts,
  type SessionInfo,
  type SessionTaskType,
} from "@lcode/contracts";
import { tokenizeMemoryRecallText } from "../memory/recall/tokenizer.js";
import { activeSessionMessagesForSession } from "./active-session-messages.js";
import { truncateText } from "./utils.js";

const SYSTEM_REMINDER_PATTERN = /<\/?system-reminder\b/iu;

export const SESSION_HISTORY_SEARCH_TASK_TYPES = [
  "interactive",
  "fork",
  "workflow_parent",
] as const satisfies readonly SessionTaskType[];

const SESSION_HISTORY_SEARCH_TASK_TYPE_SET = new Set<SessionTaskType>(
  SESSION_HISTORY_SEARCH_TASK_TYPES,
);

export function isSessionHistorySearchTaskType(taskType: SessionTaskType): boolean {
  return SESSION_HISTORY_SEARCH_TASK_TYPE_SET.has(taskType);
}

export interface SessionHistoryProjection {
  activeMessageCount: number;
  projectedCharacterCount: number;
  searchText: string;
  truncated: boolean;
}

export interface SessionHistorySearchCandidate {
  projection: SessionHistoryProjection;
  session: SessionInfo;
}

export interface RankedSessionHistorySearchCandidate extends SessionHistorySearchCandidate {
  preview: string;
  previewTruncated: boolean;
  score: number;
  title: string;
}

export function projectSessionHistorySearchText(input: {
  characterLimit?: number;
  messages: MessageWithParts[];
  session: SessionInfo;
}): SessionHistoryProjection {
  const characterLimit = clampProjectionCharacterLimit(input.characterLimit);
  const activeMessages = activeSessionMessagesForSession(input.messages, input.session);
  const chunks: string[] = [];
  let projectedCharacterCount = 0;
  let truncated = false;

  outer: for (const message of activeMessages) {
    const role = searchableRole(message);
    if (!role) continue;

    for (const part of message.parts) {
      if (
        part.type !== "text" ||
        part.ignored === true ||
        part.synthetic === true ||
        SYSTEM_REMINDER_PATTERN.test(part.text)
      ) {
        continue;
      }
      const text = part.text.trim();
      if (!text) continue;

      const chunk = `${role === "user" ? "User" : "Assistant"}: ${text}`;
      const separatorLength = chunks.length === 0 ? 0 : 2;
      const remaining = characterLimit - projectedCharacterCount - separatorLength;
      if (remaining <= 0) {
        truncated = true;
        break outer;
      }
      const admitted = truncateText(chunk, remaining);
      chunks.push(admitted);
      projectedCharacterCount += separatorLength + admitted.length;
      if (admitted.length < chunk.length) {
        truncated = true;
        break outer;
      }
    }
  }

  return {
    activeMessageCount: activeMessages.length,
    projectedCharacterCount,
    searchText: chunks.join("\n\n"),
    truncated,
  };
}

export function rankSessionHistorySearchCandidates(input: {
  candidates: readonly SessionHistorySearchCandidate[];
  previewCharacterLimit?: number;
  query: string;
}): RankedSessionHistorySearchCandidate[] {
  const normalizedQuery = input.query.normalize("NFKC").trim().toLowerCase();
  const queryTokens = [...new Set(tokenizeMemoryRecallText(input.query))];
  if (!normalizedQuery && queryTokens.length === 0) return [];
  const previewCharacterLimit = clampPreviewCharacterLimit(input.previewCharacterLimit);

  const ranked = input.candidates.flatMap((candidate) => {
    const boundedTitle = candidate.session.title.slice(
      0,
      SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT,
    );
    const title = boundedTitle.normalize("NFKC").toLowerCase();
    const searchText = candidate.projection.searchText.normalize("NFKC").toLowerCase();
    const documentTokens = countTokens(
      tokenizeMemoryRecallText(`${boundedTitle}\n${candidate.projection.searchText}`),
    );
    const titleTokens = new Set(tokenizeMemoryRecallText(boundedTitle));
    let score = normalizedQuery && `${title}\n${searchText}`.includes(normalizedQuery) ? 20 : 0;

    for (const token of queryTokens) {
      const frequency = documentTokens.get(token) ?? 0;
      if (frequency === 0) continue;
      score += 2 + Math.min(frequency, 5);
      if (titleTokens.has(token)) score += 3;
    }
    if (score <= 0) return [];

    return [
      {
        ...candidate,
        preview: buildQueryCenteredPreview(
          candidate.projection.searchText,
          normalizedQuery,
          queryTokens,
          previewCharacterLimit,
        ),
        previewTruncated: candidate.projection.searchText.length > previewCharacterLimit,
        score,
        title: boundedTitle,
      },
    ];
  });

  ranked.sort((left, right) => {
    const scoreDifference = right.score - left.score;
    if (scoreDifference !== 0) return scoreDifference;
    const updatedDifference = right.session.time.updated - left.session.time.updated;
    if (updatedDifference !== 0) return updatedDifference;
    const leftId = String(left.session.id);
    const rightId = String(right.session.id);
    return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
  });
  return ranked;
}

function searchableRole(message: MessageWithParts): "assistant" | "user" | undefined {
  const semantics = message.info.semantics;
  if (semantics?.transcriptVisibility === "hidden") return undefined;

  if (message.info.role === "user") {
    if (
      message.info.synthetic === true ||
      message.info.source !== undefined ||
      message.info.visibility === "model-only"
    ) {
      return undefined;
    }
    if (semantics && (semantics.origin !== "real_user" || semantics.uiVisibility !== "visible")) {
      return undefined;
    }
    return "user";
  }

  if (message.info.summary === true) return undefined;
  if (
    semantics &&
    (semantics.origin !== "agent_runtime" ||
      semantics.kind !== "assistant_response" ||
      semantics.uiVisibility !== "visible")
  ) {
    return undefined;
  }
  return "assistant";
}

function clampProjectionCharacterLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT;
  }
  return Math.max(0, Math.min(SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT, Math.floor(value)));
}

function countTokens(tokens: readonly string[]): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function buildQueryCenteredPreview(
  text: string,
  normalizedQuery: string,
  queryTokens: readonly string[],
  characterLimit: number,
): string {
  if (text.length <= characterLimit) return text;

  const normalizedText = text.normalize("NFKC").toLowerCase();
  const offsets = [
    ...(normalizedQuery ? [normalizedText.indexOf(normalizedQuery)] : []),
    ...queryTokens.map((token) => normalizedText.indexOf(token)),
  ].filter((offset) => offset >= 0);
  const firstMatch = offsets.length > 0 ? Math.min(...offsets) : 0;
  const start = Math.max(0, firstMatch - 200);
  const prefix = start > 0 ? "..." : "";
  const available = characterLimit - prefix.length;
  return `${prefix}${truncateText(text.slice(start), available)}`;
}

function clampPreviewCharacterLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT;
  }
  return Math.max(1, Math.min(SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT, Math.trunc(value)));
}
