// ============================================================
// Core Errors - Error types for the agent loop
// ============================================================

// -----------------------------------------------
// Error Types
// -----------------------------------------------

export const CoreErrorType = {
  // Session errors
  SessionNotFound: "session_not_found",
  SessionAlreadyExists: "session_already_exists",
  SessionCorrupted: "session_corrupted",

  // Turn errors
  TurnNotFound: "turn_not_found",
  TurnInProgress: "turn_in_progress",
  InvalidTurnPhase: "invalid_turn_phase",
  TurnCancelled: "turn_cancelled",

  // Model errors
  ModelError: "model_error",
  ModelTimeout: "model_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",

  // Tool errors
  ToolNotFound: "tool_not_found",
  ToolExecutionFailed: "tool_execution_failed",
  ToolTimeout: "tool_timeout",
  ToolCancelled: "tool_cancelled",
  ToolMaxCalls: "tool_max_calls",
  InvalidInput: "invalid_input",

  // Permission errors
  PermissionDenied: "permission_denied",
  PermissionEscalation: "permission_escalation",
  PermissionTimeout: "permission_timeout",

  // State errors
  InvalidStateTransition: "invalid_state_transition",
  EventOutOfOrder: "event_out_of_order",
  ProjectionCorrupted: "projection_corrupted",

  // System errors
  StorageError: "storage_error",
  ConfigurationError: "configuration_error",
  Cancelled: "cancelled",
  UnknownError: "unknown_error",
} as const;

export type CoreErrorType = (typeof CoreErrorType)[keyof typeof CoreErrorType];

// -----------------------------------------------
// Core Error
// -----------------------------------------------

export interface CoreError extends Error {
  type: CoreErrorType;
  code: string;
  message: string;
  cause?: Error;
  context?: Record<string, unknown>;
  recoverable: boolean;
  retryable: boolean;
  timestamp: Date;
}

// -----------------------------------------------
// Error Factory
// -----------------------------------------------

export function createCoreError(
  type: CoreErrorType,
  message: string,
  options?: {
    cause?: Error;
    context?: Record<string, unknown>;
    recoverable?: boolean;
    retryable?: boolean;
  },
): CoreError {
  const error = new Error(message) as CoreError;
  error.type = type;
  error.code = type.toUpperCase().replace(/_/g, "_");
  error.cause = options?.cause;
  error.context = options?.context;
  error.recoverable = options?.recoverable ?? false;
  error.retryable = options?.retryable ?? false;
  error.timestamp = new Date();
  return error;
}

// -----------------------------------------------
// Error Predicates
// -----------------------------------------------

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof Error && "type" in error && "code" in error;
}

export function isRetryable(error: CoreError): boolean {
  return error.retryable;
}

export function isRecoverable(error: CoreError): boolean {
  return error.recoverable;
}

// -----------------------------------------------
// Specific Error Creators
// -----------------------------------------------

export function sessionNotFound(sessionId: string): CoreError {
  return createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${sessionId}`, {
    context: { sessionId },
    recoverable: true,
  });
}

export function invalidTurnPhase(current: string, expected: string[]): CoreError {
  return createCoreError(CoreErrorType.InvalidTurnPhase, `Invalid turn phase: ${current}`, {
    context: { current, expected },
    recoverable: true,
  });
}

export function toolNotFound(toolName: string): CoreError {
  return createCoreError(CoreErrorType.ToolNotFound, `Tool not found: ${toolName}`, {
    context: { toolName },
    recoverable: false,
  });
}

export function toolExecutionFailed(toolName: string, cause?: Error): CoreError {
  return createCoreError(CoreErrorType.ToolExecutionFailed, `Tool execution failed: ${toolName}`, {
    cause,
    context: { toolName },
    recoverable: true,
    retryable: true,
  });
}

export function permissionDenied(toolName: string, reason?: string): CoreError {
  return createCoreError(CoreErrorType.PermissionDenied, `Permission denied: ${toolName}`, {
    context: { toolName, reason },
    recoverable: true,
    retryable: false,
  });
}
