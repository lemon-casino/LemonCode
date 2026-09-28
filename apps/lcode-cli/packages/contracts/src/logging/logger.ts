// ============================================================
// Logger contracts - cross-cutting logging capability
// ============================================================

import type { TraceId } from "../interfaces/shared.js";

// -----------------------------------------------
// Log Levels
// -----------------------------------------------

export const LogLevel = {
  Debug: 0,
  Info: 1,
  Warn: 2,
  Error: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LogLevelName = {
  [LogLevel.Debug]: "DEBUG",
  [LogLevel.Info]: "INFO",
  [LogLevel.Warn]: "WARN",
  [LogLevel.Error]: "ERROR",
} as const;

// -----------------------------------------------
// Log Entry
// -----------------------------------------------

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  levelName: string;
  event?: string;
  module?: string;
  message: string;
  traceId?: TraceId;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  durationMs?: number;
  status?: "started" | "waiting" | "completed" | "failed" | "cancelled";
  context?: Record<string, unknown>;
  error?: LogError;
}

export interface LogError {
  name: string;
  message: string;
  code?: string;
  type?: string;
  stack?: string;
  context?: Record<string, unknown>;
  cause?: LogError;
}

// -----------------------------------------------
// Log Context
// -----------------------------------------------

export interface LogContext {
  traceId?: TraceId;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  event?: string;
  module?: string;
  durationMs?: number;
  status?: "started" | "waiting" | "completed" | "failed" | "cancelled";
  [key: string]: unknown;
}

// -----------------------------------------------
// Logger Port Interface
// -----------------------------------------------

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;
  child(context: LogContext): Logger;
}

// -----------------------------------------------
// Logger Factory
// -----------------------------------------------

export interface LoggerFactory {
  createLogger(category: string): Logger;
  withContext(context: LogContext): Logger;
  setLevel(level: LogLevel): void;
}

export interface LogRedactor {
  redact(value: unknown): unknown;
}
