import type { DatabaseSync } from "node:sqlite";
import type { ModelUsageRecord, ToolUsageRecord, TurnUsageRecord } from "@lcode/contracts";
import { encodeJson } from "../json.js";
import {
  boolean,
  inputSideTokensFromNormalizedUsage,
  integer,
  toolUsageValues,
} from "./usage-values.js";

export { queryAppUsage, queryTaskUsage } from "./usage-query.js";

const USAGE_RETENTION_DAYS = 30;
const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export async function recordModelUsage(db: DatabaseSync, input: ModelUsageRecord): Promise<void> {
  const computedTotalTokens =
    input.computedTotalTokens ??
    inputSideTokensFromNormalizedUsage(
      input.inputTokens,
      input.cacheCreationInputTokens,
      input.cacheReadInputTokens,
    ) + integer(input.outputTokens);

  // 数据库沿用 0010 创建的历史列名；领域层使用更准确的 reasoningLevel。
  db.prepare(
    `
      insert into model_usage (
        id,
        logical_request_id,
        attempt_index,
        session_id,
        turn_id,
        trace_id,
        span_id,
        assistant_message_id,
        parent_user_message_id,
        query_source,
        provider_id,
        model_id,
        variant,
        agent,
        mode,
        task_type,
        status,
        started_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        finish_reason,
        tool_call_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        provider_total_tokens,
        computed_total_tokens,
        retry_count,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code,
        error_message,
        raw_usage_json,
        provider_metadata_json
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        logical_request_id = excluded.logical_request_id,
        attempt_index = excluded.attempt_index,
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        trace_id = excluded.trace_id,
        span_id = excluded.span_id,
        assistant_message_id = excluded.assistant_message_id,
        parent_user_message_id = excluded.parent_user_message_id,
        query_source = excluded.query_source,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        variant = excluded.variant,
        agent = excluded.agent,
        mode = excluded.mode,
        task_type = excluded.task_type,
        status = excluded.status,
        started_at = excluded.started_at,
        first_token_at = excluded.first_token_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        time_to_first_token_ms = excluded.time_to_first_token_ms,
        finish_reason = excluded.finish_reason,
        tool_call_count = excluded.tool_call_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        provider_total_tokens = excluded.provider_total_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = excluded.error_type,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        raw_usage_json = excluded.raw_usage_json,
        provider_metadata_json = excluded.provider_metadata_json
      `,
  ).run(
    input.id,
    input.logicalRequestId,
    integer(input.attemptIndex),
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.spanID ?? null,
    input.assistantMessageID ?? null,
    input.parentUserMessageID ?? null,
    input.querySource,
    input.providerId,
    input.modelId,
    input.reasoningLevel ?? null,
    input.agent ?? null,
    input.mode ?? null,
    input.taskType ?? null,
    input.status,
    input.startedAt,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    input.finishReason ?? null,
    integer(input.toolCallCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    input.providerTotalTokens ?? null,
    computedTotalTokens,
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    encodeJson(input.rawUsage),
    encodeJson(input.providerMetadata),
  );
  await pruneUsage(db);
}

export async function upsertTurnUsage(db: DatabaseSync, input: TurnUsageRecord): Promise<void> {
  db.prepare(
    `
      insert into turn_usage (
        session_id,
        turn_id,
        trace_id,
        user_message_id,
        status,
        started_at,
        first_model_start_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        model_request_count,
        model_retry_count,
        tool_call_count,
        tool_error_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        computed_total_tokens,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      on conflict(session_id, turn_id) do update set
        trace_id = coalesce(excluded.trace_id, turn_usage.trace_id),
        user_message_id = coalesce(excluded.user_message_id, turn_usage.user_message_id),
        status = excluded.status,
        started_at = min(turn_usage.started_at, excluded.started_at),
        first_model_start_at = coalesce(turn_usage.first_model_start_at, excluded.first_model_start_at),
        first_token_at = coalesce(turn_usage.first_token_at, excluded.first_token_at),
        completed_at = coalesce(excluded.completed_at, turn_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, turn_usage.duration_ms),
        time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn_usage.time_to_first_token_ms),
        model_request_count = excluded.model_request_count,
        model_retry_count = excluded.model_retry_count,
        tool_call_count = excluded.tool_call_count,
        tool_error_count = excluded.tool_error_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = coalesce(excluded.error_type, turn_usage.error_type),
        error_code = coalesce(excluded.error_code, turn_usage.error_code)
      `,
  ).run(
    input.sessionID,
    input.turnID,
    input.traceID ?? null,
    input.userMessageID ?? null,
    input.status,
    input.startedAt,
    input.firstModelStartAt ?? null,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    integer(input.modelRequestCount),
    integer(input.modelRetryCount),
    integer(input.toolCallCount),
    integer(input.toolErrorCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    integer(input.computedTotalTokens),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
  );
  await pruneUsage(db);
}

export async function upsertToolUsage(db: DatabaseSync, input: ToolUsageRecord): Promise<void> {
  db.prepare(
    `
      insert into tool_usage (
        id,
        session_id,
        turn_id,
        trace_id,
        tool_call_id,
        tool_name,
        side_effect_scope,
        read_only,
        destructive,
        approval_status,
        status,
        started_at,
        first_output_at,
        completed_at,
        duration_ms,
        time_to_first_output_ms,
        exit_code,
        output_bytes,
        stdout_bytes,
        stderr_bytes,
        truncated,
        retry_count,
        retryable,
        cancelled_by_user,
        error_type,
        error_code,
        error_message
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        turn_id = coalesce(excluded.turn_id, tool_usage.turn_id),
        trace_id = coalesce(excluded.trace_id, tool_usage.trace_id),
        tool_call_id = excluded.tool_call_id,
        tool_name = case
          when excluded.tool_name = 'unknown' then tool_usage.tool_name
          else excluded.tool_name
        end,
        side_effect_scope = coalesce(excluded.side_effect_scope, tool_usage.side_effect_scope),
        read_only = coalesce(excluded.read_only, tool_usage.read_only),
        destructive = coalesce(excluded.destructive, tool_usage.destructive),
        approval_status = coalesce(excluded.approval_status, tool_usage.approval_status),
        status = case
          when tool_usage.status in ('completed', 'error', 'cancelled') and excluded.status = 'running'
            then tool_usage.status
          else excluded.status
        end,
        started_at = min(tool_usage.started_at, excluded.started_at),
        first_output_at = coalesce(tool_usage.first_output_at, excluded.first_output_at),
        completed_at = coalesce(excluded.completed_at, tool_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, tool_usage.duration_ms),
        time_to_first_output_ms = coalesce(excluded.time_to_first_output_ms, tool_usage.time_to_first_output_ms),
        exit_code = coalesce(excluded.exit_code, tool_usage.exit_code),
        output_bytes = max(tool_usage.output_bytes, excluded.output_bytes),
        stdout_bytes = max(tool_usage.stdout_bytes, excluded.stdout_bytes),
        stderr_bytes = max(tool_usage.stderr_bytes, excluded.stderr_bytes),
        truncated = max(tool_usage.truncated, excluded.truncated),
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        error_type = coalesce(excluded.error_type, tool_usage.error_type),
        error_code = coalesce(excluded.error_code, tool_usage.error_code),
        error_message = coalesce(excluded.error_message, tool_usage.error_message)
      `,
  ).run(...toolUsageValues(input));
  await pruneUsage(db);
}

export async function pruneUsage(
  db: DatabaseSync,
  input: { beforeTime?: number } = {},
): Promise<void> {
  const beforeTime = input.beforeTime ?? Date.now() - USAGE_RETENTION_MS;
  db.exec("begin immediate");
  try {
    db.prepare("delete from model_usage where started_at < ?").run(beforeTime);
    db.prepare("delete from turn_usage where started_at < ?").run(beforeTime);
    db.prepare("delete from tool_usage where started_at < ?").run(beforeTime);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
