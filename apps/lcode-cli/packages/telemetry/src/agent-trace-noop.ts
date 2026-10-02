import type {
  AgentExecutionTelemetryPort,
  ModelExecutionTelemetryPort,
  CommandExecutionSpanWriter,
  ToolExecutionSpanWriter,
  AgentStepSpanWriter,
  AgentTurnSpanWriter,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
} from "@lcode/contracts/telemetry";

export const NOOP_SCOPE = {
  captureCausation: () => undefined,
  run: <T>(execute: () => T): T => execute(),
};

export const NOOP_COMMAND_WRITER: CommandExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishBackgrounded() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstOutput() {},
  markTerminationRequested() {},
  setExitCode() {},
  setOutputBytes() {},
  setSignal() {},
  setTimedOut() {},
};

export const NOOP_TOOL_WRITER: ToolExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDenied() {},
  finishFailed() {},
  markPermissionRequested() {},
  setOutputBytes() {},
  setOutputTruncated() {},
  setPermissionDecision() {},
  startCommand: () => NOOP_COMMAND_WRITER,
};

export const NOOP_STEP_WRITER: AgentStepSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
};

export const NOOP_TURN_WRITER: AgentTurnSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
};

export const NOOP_COMPACTION_WRITER: ContextCompactionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
  markFallbackSelected() {},
  setInputTokens() {},
  setOutputTokens() {},
};

export const NOOP_DETACHED_WRITER: DetachedOperationSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  setResultType() {},
};

export const NOOP_MODEL_ATTEMPT_WRITER: ModelAttemptSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstContent() {},
  markFirstProviderEvent() {},
  markFirstText() {},
  markStreamStalled() {},
  setCacheReadTokens() {},
  setCacheWriteTokens() {},
  setEffectiveReasoningBudgetTokens() {},
  setEffectiveReasoningControl() {},
  setEffectiveReasoningLevel() {},
  setEffectiveReasoningState() {},
  setFinishReason() {},
  setHttpStatusCode() {},
  setInputTokens() {},
  setOutputTokens() {},
  setProviderErrorCode() {},
  setProviderErrorMessage() {},
  setProviderRequestId() {},
  setReasoningTokens() {},
  setResponseModel() {},
  setRetryAfterMs() {},
  setStreamOutputCommitted() {},
};

export const NOOP_MODEL_CALL_WRITER: ModelCallSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFallbackSelected() {},
  startAttempt: () => NOOP_MODEL_ATTEMPT_WRITER,
};

export class NoopAgentExecutionTelemetry
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  abandonSession(): void {}
  captureCausation() {
    return undefined;
  }
  startCall(): ModelCallSpanWriter {
    return NOOP_MODEL_CALL_WRITER;
  }
  startCompaction(): ContextCompactionSpanWriter {
    return NOOP_COMPACTION_WRITER;
  }
  startDetachedOperation(): DetachedOperationSpanWriter {
    return NOOP_DETACHED_WRITER;
  }
  startStep(): AgentStepSpanWriter {
    return NOOP_STEP_WRITER;
  }
  startTool(): ToolExecutionSpanWriter {
    return NOOP_TOOL_WRITER;
  }
  startTurn(): AgentTurnSpanWriter {
    return NOOP_TURN_WRITER;
  }
}
