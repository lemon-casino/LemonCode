import type { TimelineItem } from "../src/shared.js";
import { isRecord, stringValue } from "./sources.js";
import type {
  DbMessageRecord,
  DbPartRecord,
  EventRecord,
  LoadedObservation,
  LogRecord,
} from "./types.js";
import {
  compareIsoDesc,
  eventToolCallId,
  modelName,
  extractUsage,
  textFromPayload,
  arrayValue,
} from "./analyzer-values.js";

export function buildTimeline(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    items.push(timelineFromLog(log));
  }

  for (const event of observation.events.records) {
    if (event.traceId !== traceId) continue;
    items.push(timelineFromEvent(event));
  }

  const db = observation.db.records[0];
  if (db && sessions.size > 0) {
    for (const message of db.messages) {
      if (sessions.has(message.sessionId)) {
        items.push(timelineFromDbMessage(message));
      }
    }
    for (const part of db.parts) {
      if (sessions.has(part.sessionId)) {
        items.push(timelineFromDbPart(part));
      }
    }
  }

  return items.sort((left, right) => compareIsoDesc(left.at, right.at));
}

function timelineFromLog(log: LogRecord): TimelineItem {
  const label = log.event ?? log.message ?? "log";
  return {
    id: `log:${log.sourcePath}:${log.line}`,
    at: log.timestamp,
    source: "log",
    kind: log.event ?? "log",
    label,
    severity: normalizeLogLevel(log.level),
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    summary: log.message ?? log.event ?? "结构化日志条目",
    payload: log.context ?? log.error,
  };
}

function timelineFromEvent(event: EventRecord): TimelineItem {
  return {
    id: `event:${event.id}`,
    at: event.timestamp,
    source: "eventlog",
    kind: event.type,
    label: event.type,
    traceId: event.traceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    toolCallId: eventToolCallId(event.payload),
    summary: summarizeEvent(event),
    payload: event.payload,
  };
}

function timelineFromDbMessage(message: DbMessageRecord): TimelineItem {
  return {
    id: `sqlite:message:${message.id}`,
    at: message.createdAt,
    source: "sqlite",
    kind: "message",
    label: `${formatRole(message.role)}消息`,
    sessionId: message.sessionId,
    summary: summarizeDbMessage(message),
    payload: message.data,
  };
}

function timelineFromDbPart(part: DbPartRecord): TimelineItem {
  return {
    id: `sqlite:part:${part.id}`,
    at: part.createdAt,
    source: "sqlite",
    kind: `part:${part.type ?? "unknown"}`,
    label: `${part.type ?? "未知"} 片段`,
    sessionId: part.sessionId,
    summary: summarizeDbPart(part),
    payload: part.data,
  };
}

export function summarizeEvent(event: EventRecord): string {
  const payload = event.payload;
  switch (event.type) {
    case "model_request": {
      const title = `模型请求 ${modelName(payload) ?? ""}`.trim();
      const messages = summarizeProviderMessages(payload);
      return messages ? `${title}\n${messages}` : title;
    }
    case "model_complete": {
      const usage = extractUsage(payload);
      const title = `模型完成，${usage.totalTokens || usage.inputTokens + usage.outputTokens} Token`;
      const content = textFromPayload(payload);
      return content ? `${title}\n${content}` : title;
    }
    case "tool_call_scheduled":
    case "tool_call_started":
    case "tool_call_result":
    case "tool_call_error":
      return [
        `${stringValue(payload?.toolName) ?? "工具"} ${stringValue(payload?.toolCallId) ?? ""}`.trim(),
        textFromPayload(payload),
      ]
        .filter(Boolean)
        .join("\n");
    case "turn_complete":
      return `轮次完成：${stringValue(payload?.resultType) ?? "success"}`;
    case "user_message":
    case "assistant_message":
      return textFromPayload(payload) ?? String(payload?.content ?? event.type);
    default:
      return [event.type, textFromPayload(payload)].filter(Boolean).join("\n");
  }
}

function summarizeDbMessage(message: DbMessageRecord): string {
  const text = stringValue(message.data.text) ?? stringValue(message.data.content);
  const title = `${formatRole(message.role)}消息 ${message.id}`;
  return text ? `${title}: ${text}` : title;
}

function summarizeProviderMessages(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const messages = arrayValue(payload?.messages).filter(isRecord);
  if (messages.length === 0) return undefined;

  return messages
    .map((message, index) => {
      const role = stringValue(message.role) ?? `message ${index + 1}`;
      const content = textFromPayload(message) ?? stringifyTimelineValue(message);
      return `${role}: ${content}`;
    })
    .join("\n");
}

function formatRole(role?: string): string {
  switch (role) {
    case "system":
      return "system ";
    case "user":
      return "user ";
    case "assistant":
      return "assistant ";
    case "tool":
      return "tool ";
    default:
      return "";
  }
}

function summarizeDbPart(part: DbPartRecord): string {
  const text = stringValue(part.data.text) ?? stringValue(part.data.output);
  return text ? `${part.type ?? "片段"}: ${text}` : `${part.type ?? "片段"} ${part.id}`;
}

function normalizeLogLevel(level?: string): TimelineItem["severity"] {
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return undefined;
  }
}

function stringifyTimelineValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
