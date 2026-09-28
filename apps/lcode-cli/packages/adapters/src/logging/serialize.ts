import type { LogContext, LogEntry, LogRedactor } from "@lcode/contracts";

export interface SerializedLogError {
  name: string;
  message: string;
  code?: string;
  type?: string;
  stack?: string;
  context?: Record<string, unknown>;
  cause?: SerializedLogError;
}

export type SerializableLogEntry = Record<string, unknown>;

export class DefaultLogRedactor implements LogRedactor {
  private readonly sensitiveKeyPattern =
    /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

  redact(value: unknown): unknown {
    return this.redactValue(value, new WeakSet(), 0);
  }

  private redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 8) {
      return "[Redacted:DepthLimit]";
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "[Redacted:Circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, seen, depth + 1));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        this.sensitiveKeyPattern.test(key)
          ? "[Redacted]"
          : this.redactValue(entryValue, seen, depth + 1),
      ]),
    );
  }
}

export function stripReservedContext(context: LogContext): Record<string, unknown> | undefined {
  const {
    durationMs: _durationMs,
    event: _event,
    module: _module,
    parentSpanId: _parentSpanId,
    sessionId: _sessionId,
    spanId: _spanId,
    status: _status,
    toolCallId: _toolCallId,
    traceId: _traceId,
    turnId: _turnId,
    ...rest
  } = context;

  return Object.keys(rest).length === 0 ? undefined : rest;
}

export function toSerializableEntry(
  entry: LogEntry,
  redactor: LogRedactor,
): SerializableLogEntry {
  const value = {
    timestamp: entry.timestamp.toISOString(),
    level: entry.levelName.toLowerCase(),
    event: entry.event,
    module: entry.module,
    message: entry.message,
    traceId: entry.traceId,
    spanId: entry.spanId,
    parentSpanId: entry.parentSpanId,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    durationMs: entry.durationMs,
    status: entry.status,
    context: redactor.redact(entry.context),
    error: redactor.redact(entry.error),
  };

  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function formatConsoleLine(entry: LogEntry): string {
  const trace = entry.traceId ? ` trace=${entry.traceId.slice(0, 8)}` : "";
  const event = entry.event ? ` event=${entry.event}` : "";
  return `${entry.levelName.toLowerCase()} [${entry.module ?? "log"}]${trace}${event} ${entry.message}`;
}

export function isLogStatus(value: unknown): value is LogEntry["status"] {
  return (
    value === "started" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export function serializeLogError(
  error: unknown,
  includeStack: boolean,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): SerializedLogError {
  if (depth > 8) {
    return {
      name: "ErrorCauseDepthLimit",
      message: "Error cause chain exceeded the serialization depth limit.",
    };
  }

  if (error === null || typeof error !== "object") {
    return {
      name: "UnknownError",
      message: String(error),
    };
  }

  if (seen.has(error)) {
    return {
      name: "ErrorCauseCircularReference",
      message: "Error cause chain contained a circular reference.",
    };
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  const cause = record.cause;
  const value: SerializedLogError = {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : String(error),
  };
  const code = stringProperty(record, "code");
  const type = stringProperty(record, "type");
  const context = record.context;

  if (code) value.code = code;
  if (type) value.type = type;
  if (includeStack && typeof record.stack === "string") value.stack = record.stack;
  if (isPlainObject(context)) value.context = context;
  if (cause !== undefined) value.cause = serializeLogError(cause, includeStack, seen, depth + 1);

  return value;
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
