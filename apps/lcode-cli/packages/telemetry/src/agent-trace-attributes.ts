import type { Attributes } from "@opentelemetry/api";
import type {
  AgentTelemetryExecutionContext,
  AgentTurnTraceStart,
  AgentStepTraceStart,
  ToolTraceStart,
  CompactionTraceStart,
  DetachedOperationTraceStart,
  ModelCallTraceStart,
  CommandTraceStart,
  ModelAttemptTraceStart,
} from "@lcode/contracts/telemetry";
import {
  compactAttributes,
  executionProjection,
  finiteNonNegative,
  integer,
  safeEnum,
  safeId,
  safeString,
  type ActiveWriterContext,
} from "./agent-trace-support.js";
import {
  toolCompatibilityAttributes,
  modelAttemptCompatibilityAttributes,
} from "./compatibility-adapters.js";
import type { ModelCallWriter } from "./agent-trace-model-call-writer.js";

export function turnAttributes(
  correlation: AgentTelemetryExecutionContext,
  input: AgentTurnTraceStart,
): Attributes {
  return compactAttributes({
    ...executionProjection(correlation, {
      includeActor: true,
      includeAgent: true,
      includeIdentity: true,
      includeQuery: true,
      includeSession: true,
    }),
    "zcode.agent_turn.turn_number": integer(input.turnNumber),
    "zcode.agent_turn.input_source": safeEnum(input.inputSource),
  });
}

export function stepAttributes(
  parent: ActiveWriterContext | undefined,
  input: AgentStepTraceStart,
): Attributes {
  return compactAttributes({
    ...executionProjection(parent?.correlation),
    "zcode.agent_step.step_id": safeId(input.stepId),
    "zcode.agent_step.step_index": integer(input.stepIndex),
  });
}

export function toolAttributes(
  parent: ActiveWriterContext | undefined,
  input: ToolTraceStart,
  toolName: string | undefined,
): Attributes {
  return compactAttributes({
    ...executionProjection(parent?.correlation, { includeActor: true }),
    "zcode.execution.tool_call_id": safeId(input.toolCallId),
    "zcode.tool_execution.tool_name": toolName,
    ...toolCompatibilityAttributes({
      toolCallId: input.toolCallId,
      toolName: input.registeredToolName,
    }),
  });
}

export function compactionAttributes(
  parent: ActiveWriterContext | undefined,
  input: CompactionTraceStart,
): Attributes {
  return compactAttributes({
    ...executionProjection(parent?.correlation),
    "zcode.context_compaction.trigger": safeEnum(input.trigger),
    "zcode.context_compaction.phase": safeEnum(input.phase),
    "zcode.context_compaction.model_mode": safeEnum(input.modelMode),
    "zcode.context_compaction.outer_attempt": integer(input.outerAttempt),
    "zcode.context_compaction.max_attempts": integer(input.maxAttempts),
    "zcode.context_compaction.triggering_step_index": integer(input.triggeringStepIndex),
    "zcode.context_compaction.policy_context_window_tokens": finiteNonNegative(
      input.policyContextWindowTokens,
    ),
    "zcode.context_compaction.threshold_tokens": finiteNonNegative(input.thresholdTokens),
    "zcode.context_compaction.token_source": safeEnum(input.tokenSource),
    "zcode.context_compaction.recovered_from_logical_call_id": safeId(
      input.recoveredFromLogicalCallId,
    ),
  });
}

export function detachedAttributes(input: DetachedOperationTraceStart): Attributes {
  return compactAttributes({
    ...executionProjection(input.context, {
      includeActor: true,
      includeQuery: true,
      includeSession: true,
    }),
    "zcode.detached_operation.operation": safeEnum(input.operation),
    "zcode.detached_operation.execution_kind": safeEnum(input.executionKind),
    "zcode.detached_operation.trigger": safeEnum(input.trigger),
    "zcode.detached_operation.target_kind": safeEnum(input.targetKind),
    "zcode.detached_operation.goal_iteration": integer(input.goalIteration),
    "zcode.detached_operation.chunk_index": integer(input.chunkIndex),
    "zcode.detached_operation.chunk_count": integer(input.chunkCount),
  });
}

export function modelCallAttributes(
  parent: ActiveWriterContext | undefined,
  input: ModelCallTraceStart,
): Attributes {
  return compactAttributes({
    ...executionProjection(parent?.correlation, {
      includeActor: true,
      includeQuery: true,
      includeSession: true,
    }),
    "zcode.execution.logical_call_id": safeId(input.logicalCallId),
    "zcode.model_call.operation": safeEnum(input.operation),
    "zcode.model_call.streaming": input.streaming,
    "zcode.model_call.model_role": safeEnum(input.modelRole),
    "zcode.model_call.requested_provider_id": safeString(input.requested.providerId, 128),
    "zcode.model_call.requested_model": safeString(input.requested.requestedModel, 128),
    "zcode.model_call.reasoning_capability": safeEnum(input.requested.reasoning.capability),
    "zcode.model_call.reasoning_requested_state": safeEnum(
      input.requested.reasoning.requestedState,
    ),
    "zcode.model_call.reasoning_requested_control": safeEnum(
      input.requested.reasoning.requestedControl,
    ),
    "zcode.model_call.reasoning_requested_level": safeString(
      input.requested.reasoning.requestedLevel,
      128,
    ),
    "zcode.model_call.reasoning_requested_budget_tokens": integer(
      input.requested.reasoning.requestedBudgetTokens,
    ),
    "zcode.model_call.call_cause": safeEnum(input.callCause),
    "zcode.model_call.previous_logical_call_id": safeId(input.previousLogicalCallId),
  });
}

export function commandAttributes(
  parent: ActiveWriterContext,
  input: CommandTraceStart,
): Attributes {
  return compactAttributes({
    ...executionProjection(parent.correlation),
    "zcode.execution.tool_call_id": safeId(parent.toolCallId),
    "zcode.command_execution.safe_name": safeString(input.safeName, 128),
    "zcode.command_execution.category": safeEnum(input.category),
    "zcode.command_execution.command_count": integer(input.commandCount),
    "zcode.command_execution.shell_kind": safeEnum(input.shellKind),
    "zcode.command_execution.sandboxed": input.sandboxed,
  });
}

export function modelAttemptAttributes(
  parent: ActiveWriterContext,
  parentWriter: ModelCallWriter,
  input: ModelAttemptTraceStart,
): Attributes {
  const target = input.target;
  return compactAttributes({
    ...executionProjection(parent.correlation, {
      includeActor: true,
      includeQuery: true,
      includeSession: true,
    }),
    "zcode.execution.tool_call_id": safeId(parent.toolCallId),
    "zcode.execution.logical_call_id": parentWriter.logicalCallId,
    "zcode.execution.model_operation": parentWriter.operation,
    "zcode.execution.model_role": parentWriter.modelRole,
    "zcode.model_attempt.request_id": safeId(input.requestId),
    "zcode.model_attempt.attempt_number": integer(input.attemptNumber),
    "zcode.model_attempt.max_attempts": integer(input.maxAttempts),
    "zcode.model_attempt.attempt_cause": safeEnum(input.attemptCause),
    "zcode.model_attempt.previous_request_id": safeId(input.previousRequestId),
    "zcode.model_attempt.retry_delay_ms": finiteNonNegative(input.retryDelayMs),
    "zcode.model_attempt.provider_id": safeString(target.providerId, 128),
    "zcode.model_attempt.provider_kind": safeEnum(target.providerKind),
    "zcode.model_attempt.provider_origin": safeString(target.providerOrigin),
    "zcode.model_attempt.provider_route": safeString(target.providerRoute),
    "zcode.model_attempt.requested_model": safeString(target.requestedModel, 128),
    "zcode.model_attempt.transport": safeEnum(input.transport),
    "zcode.model_attempt.api_operation": safeEnum(input.apiOperation),
    "zcode.model_attempt.reasoning_capability": safeEnum(target.reasoning.capability),
    "zcode.model_attempt.reasoning_requested_state": safeEnum(target.reasoning.requestedState),
    "zcode.model_attempt.reasoning_requested_control": safeEnum(target.reasoning.requestedControl),
    "zcode.model_attempt.reasoning_requested_level": safeString(
      target.reasoning.requestedLevel,
      128,
    ),
    "zcode.model_attempt.reasoning_requested_budget_tokens": integer(
      target.reasoning.requestedBudgetTokens,
    ),
    ...modelAttemptCompatibilityAttributes(target),
  });
}
