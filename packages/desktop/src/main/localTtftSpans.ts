import { createHash } from "node:crypto";
import { SpanKind, SpanStatusCode, TraceFlags, type HrTime } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { LOCAL_TTFT_STAGES, type LocalTtftRecord } from "@lcode/shared";

export function createLocalTtftSpans(
  record: LocalTtftRecord,
  resource: ReadableSpan["resource"],
  includeRecord: boolean,
  completeRecord: LocalTtftRecord,
): ReadableSpan[] {
  const traceId = record.observationId.replaceAll("-", "");
  const rootId = traceId.slice(0, 16);
  const attributes = Object.fromEntries(
    Object.entries({
      observation_id: record.observationId,
      command_id: record.commandId,
      input_id: record.commandId,
      query_id: record.queryId,
      turn_id: record.turnId,
      product_turn_id: record.productTurnId,
      request_id: record.requestId,
      logical_call_id: record.logicalCallId,
      cli_version: record.cliVersion,
      session_id: record.sessionId,
      cli_instance_id: record.cliInstanceId,
      first_output_kind: record.firstOutputKind,
      model: record.model,
      provider: record.provider,
      quality: record.quality,
      outcome: record.outcome,
      send_mode: record.sendMode ?? "idle",
      visibility: record.visibility ?? "foreground",
      user_wait_ms: record.userWaitMs,
      execution_ms: record.executionMs,
      truncated: String(record.truncated === true),
      timing_reliable: String(record.timingReliable !== false),
      visibility_changes: JSON.stringify(record.visibilityChanges ?? []),
      clock_error_ms: record.clockErrorMs,
      ...(record.kind === "first_output"
        ? {
            unattributed_ms: record.end - record.start - coveredMs(completeRecord),
            missing_stages: LOCAL_TTFT_STAGES.filter(
              (stage) => !completeRecord.intervals.some((interval) => interval.stage === stage),
            ).join(","),
          }
        : {}),
    }).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );
  const span = (
    name: string,
    start: number,
    end: number,
    root: boolean,
    extra = {},
  ): ReadableSpan => {
    const spanId = root
      ? rootId
      : createHash("sha256")
          .update(`${traceId}:${name}:${JSON.stringify(extra)}`)
          .digest("hex")
          .slice(0, 16);
    return {
      name,
      kind: SpanKind.INTERNAL,
      spanContext: () => ({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
      ...(root
        ? {}
        : { parentSpanContext: { traceId, spanId: rootId, traceFlags: TraceFlags.SAMPLED } }),
      startTime: hr(start),
      endTime: hr(end),
      duration: hr(end - start),
      status: { code: SpanStatusCode.UNSET },
      attributes: { ...attributes, ...extra },
      links: [],
      events: [],
      ended: true,
      resource,
      instrumentationScope: { name: "@lcode/local-ttft", version: "1" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  };
  return [
    ...(includeRecord
      ? [
          span(
            record.kind === "first_output" ? "local_ttft" : `local_ttft.${record.kind}`,
            record.start,
            record.end,
            record.kind === "first_output",
            { checkpoint_id: record.checkpointId ?? record.kind },
          ),
        ]
      : []),
    ...record.intervals.map((interval) =>
      span(`local_ttft.${interval.stage}`, interval.start, interval.end, false, {
        clock_source: interval.source,
      }),
    ),
    ...(record.details ?? []).map((detail) =>
      span(
        `local_ttft.${detail.stage === "attempt" || detail.stage === "retry_wait" || detail.stage === "user_confirmation" ? detail.stage : `prepare.${detail.stage}`}${detail.end === undefined ? ".started" : ""}`,
        detail.start,
        detail.end ?? detail.start,
        false,
        {
          detail_id: detail.id,
          clock_source: detail.source,
          ...(detail.requestId ? { request_id: detail.requestId } : {}),
          ...(detail.logicalCallId ? { logical_call_id: detail.logicalCallId } : {}),
          role: detail.role ?? "preparation",
          detail_outcome: detail.outcome ?? "unclosed",
        },
      ),
    ),
  ];
}
function coveredMs(record: LocalTtftRecord): number {
  const intervals = [
    ...record.intervals,
    ...(record.details ?? []).flatMap((detail) =>
      detail.end === undefined
        ? []
        : [{ start: detail.start, end: detail.end, source: detail.source }],
    ),
  ]
    .filter((interval) => record.quality !== "clock_invalid" || interval.source === "renderer")
    .map((interval) => ({
      start: Math.max(record.start, interval.start),
      end: Math.min(record.end, interval.end),
    }))
    .filter((interval) => interval.end >= interval.start)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let end = record.start;
  for (const interval of intervals) {
    if (interval.end > end) covered += interval.end - Math.max(end, interval.start);
    end = Math.max(end, interval.end);
  }
  return covered;
}
function hr(ms: number): HrTime {
  const seconds = Math.floor(ms / 1000);
  return [seconds, Math.floor((ms - seconds * 1000) * 1e6)];
}
