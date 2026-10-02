import type {
  CacheReport,
  CacheSegment,
  ContextSnapshotView,
  DeveloperRequest,
} from "../src/shared.js";
import { isRecord, numberValue, stringValue } from "./sources.js";
import type { DbObservation, EventRecord, LoadedObservation } from "./types.js";
import {
  compareIsoAsc,
  extractUsage,
  arrayValue,
  modelName,
  estimateTokens,
  preview,
} from "./analyzer-values.js";

export function buildCacheReports(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): CacheReport[] {
  const reports: CacheReport[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));
  const modelRequests = traceEvents.filter((event) => event.type === "model_request");

  for (const request of modelRequests) {
    const complete = findNextEvent(traceEvents, request, "model_complete");
    const turnComplete = findNextEvent(traceEvents, request, "turn_complete");
    const usage = extractUsage(complete?.payload);
    const cacheStats = isRecord(turnComplete?.payload?.cacheStats)
      ? turnComplete?.payload?.cacheStats
      : undefined;
    const messages = arrayValue(request.payload?.messages).filter(isRecord);
    reports.push({
      id: `cache:${request.id}`,
      at: complete?.timestamp ?? request.timestamp,
      traceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      model: modelName(request.payload),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      hitRate: usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : null,
      segments: cacheSegmentsFromMessages(messages, cacheStats, usage.cacheReadTokens),
      limitations: cacheLimitations(messages, cacheStats, usage.cacheReadTokens),
    });
  }

  if (reports.length === 0) {
    reports.push(...cacheReportsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return reports;
}

function findNextEvent(
  events: EventRecord[],
  current: EventRecord,
  type: string,
): EventRecord | undefined {
  const currentAt = current.timestamp ?? "";
  return events.find((event) => {
    if (event.type !== type) return false;
    if (current.turnId && event.turnId !== current.turnId) return false;
    return !currentAt || !event.timestamp || event.timestamp >= currentAt;
  });
}

function cacheSegmentsFromMessages(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): CacheSegment[] {
  const cachedMessages = numberValue(cacheStats?.cachedMessages);
  const lastCacheHit = cacheStats?.lastCacheHit === true;

  return messages.map((message, index) => {
    const content = String(message.content ?? "");
    const hasPrefixStats = lastCacheHit && cachedMessages !== undefined;
    const status = hasPrefixStats ? (index < cachedMessages ? "hit" : "miss") : "unknown";
    return {
      id: `message-${index}`,
      status,
      role: stringValue(message.role),
      source: "message",
      tokens: estimateTokens(content),
      chars: content.length,
      preview: preview(content),
      reason: hasPrefixStats
        ? "根据 runtime 的 cachedMessages 前缀统计推断。"
        : cacheReadTokens > 0
          ? "Provider 返回了缓存 token，但没有逐文本归因。"
          : "这条消息没有缓存归因信息。",
    };
  });
}

function cacheLimitations(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): string[] {
  const limitations: string[] = [];
  if (messages.length === 0) {
    limitations.push("当前观测源没有 provider 可见的 messages。");
  }
  if (!cacheStats) {
    limitations.push("缺少 turn_complete.cacheStats，无法判断逐文本命中状态。");
  }
  if (cacheReadTokens > 0) {
    limitations.push("Provider 的缓存 token 不会标出具体命中文本。");
  }
  return limitations;
}

function cacheReportsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): CacheReport[] {
  if (!db || sessions.size === 0) return [];
  const reports: CacheReport[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    const read = numberValue(cache?.read) ?? 0;
    const write = numberValue(cache?.write) ?? 0;
    const inputTokens = numberValue(tokens?.input) ?? 0;
    reports.push({
      id: `sqlite-cache:${part.id}`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      inputTokens,
      outputTokens: numberValue(tokens?.output) ?? 0,
      totalTokens: numberValue(tokens?.total) ?? 0,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      hitRate: inputTokens > 0 ? read / inputTokens : null,
      segments: [],
      limitations:
        read > 0 || write > 0
          ? ["SQLite 里有聚合缓存 token，但没有逐文本 cache report。"]
          : ["SQLite 里有 token usage，未观察到 cache read/write。"],
    });
  }

  return reports;
}

export function buildDeveloperRequests(
  observation: LoadedObservation,
  snapshots: ContextSnapshotView[],
  reports: CacheReport[],
): DeveloperRequest[] {
  const requests: DeveloperRequest[] = [];
  const hasFullSnapshot = snapshots.some((snapshot) => snapshot.observationLevel === "full");
  const hasExactCache = reports.some((report) =>
    report.segments.some(
      (segment) =>
        Boolean(segment.contentHash) && (segment.status === "hit" || segment.status === "miss"),
    ),
  );

  if (!hasFullSnapshot) {
    requests.push({
      title: "在 model request 前产出 context_snapshot",
      eventName: "context_snapshot",
      reason: "当前数据源只能看到上下文元数据，或完全看不到 system prompt 文本。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "sections[].name/source/chars/tokens/contentHash/preview/artifactRef",
        "messages[].role/chars/tokens/contentHash/sectionRefs",
      ],
    });
  }

  if (!hasExactCache) {
    requests.push({
      title: "产出逐文本 prompt cache report",
      eventName: "prompt_cache_report",
      reason: "Provider usage 只有缓存 token，没有说明哪些文本片段命中缓存。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "usage.input/output/total/cacheRead/cacheWrite",
        "segments[].messageIndex/role/source/contentHash/tokens/cacheStatus/reason",
      ],
    });
  }

  if (observation.events.records.length === 0) {
    requests.push({
      title: "增加开发期 Session event JSONL sink",
      eventName: "session_event_jsonl_sink",
      reason: "结构化日志更像诊断索引；Session events 才是还原 trace 的事实来源。",
      schema: [
        "append-only JSONL through SessionEventSink",
        "same envelope fields as existing structured log sinks",
        "redacted artifact refs for large payloads",
      ],
    });
  }

  return requests;
}
