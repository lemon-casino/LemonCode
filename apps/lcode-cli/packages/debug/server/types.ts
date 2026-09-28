import type { ObservationSourceKind } from "../src/shared.js";

export interface ObservationOptions {
  traceId?: string;
  sessionId?: string;
  logDir?: string;
  dbPath?: string;
  eventPath?: string;
  projectId?: string;
  limit?: number;
}

export interface JsonRecord {
  value: Record<string, unknown>;
  sourcePath: string;
  line: number;
}

export interface SourceLoadResult<TRecord> {
  kind: ObservationSourceKind;
  label: string;
  path?: string;
  records: TRecord[];
  warning?: string;
}

export interface LogRecord {
  timestamp?: string;
  level?: string;
  event?: string;
  module?: string;
  message?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  durationMs?: number;
  status?: string;
  context?: Record<string, unknown>;
  error?: unknown;
  sourcePath: string;
  line: number;
}

export interface EventRecord {
  id: string;
  type: string;
  timestamp?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  sequenceNumber?: number;
  payload?: Record<string, unknown>;
  sourcePath: string;
  line: number;
}

export interface DbSessionRecord {
  id: string;
  projectId: string;
  title: string;
  directory: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbMessageRecord {
  id: string;
  sessionId: string;
  role?: string;
  createdAt?: string;
  updatedAt?: string;
  data: Record<string, unknown>;
}

export interface DbPartRecord {
  id: string;
  messageId: string;
  sessionId: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  data: Record<string, unknown>;
}

export interface DbObservation {
  sessions: DbSessionRecord[];
  messages: DbMessageRecord[];
  parts: DbPartRecord[];
}

export interface LoadedObservation {
  logs: SourceLoadResult<LogRecord>;
  events: SourceLoadResult<EventRecord>;
  db: SourceLoadResult<DbObservation>;
}
