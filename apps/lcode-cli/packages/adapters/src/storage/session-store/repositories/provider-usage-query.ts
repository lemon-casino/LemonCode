import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ProviderUsageQueryInput } from "@lcode/contracts";
import {
  providerUsageRequestSchema,
  providerUsageSnapshotSchema,
  type ProviderUsageMetrics,
  type ProviderUsageSnapshot,
} from "@lcode/shared";
import {
  providerUsageActivity,
  providerUsageCalendar,
  USAGE_DAY_MS,
} from "./provider-usage-activity.js";

const aggregate = `count(*) as requestCount,
  coalesce(sum(status = 'completed'), 0) as successCount,
  coalesce(sum(status = 'error'), 0) as errorCount,
  coalesce(sum(status = 'cancelled'), 0) as cancelledCount,
  coalesce(sum(retry_count), 0) as retryCount,
  coalesce(sum(usage_known = 1), 0) as knownUsageRequests,
  coalesce(sum(case when usage_known = 1 then computed_total_tokens else 0 end), 0) as totalTokens,
  coalesce(sum(case when usage_known = 1 then input_tokens else 0 end), 0) as inputTokens,
  coalesce(sum(case when usage_known = 1 then output_tokens else 0 end), 0) as outputTokens,
  coalesce(sum(case when usage_known = 1 then reasoning_tokens else 0 end), 0) as reasoningTokens,
  coalesce(sum(case when usage_known = 1 then cache_read_input_tokens else 0 end), 0) as cacheReadTokens,
  coalesce(sum(case when usage_known = 1 then cache_creation_input_tokens else 0 end), 0) as cacheWriteTokens,
  avg(case when time_to_first_token_ms >= 0 then time_to_first_token_ms end) as avgTimeToFirstTokenMs,
  avg(case when duration_ms >= 0 then duration_ms end) as avgDurationMs`;
type Row = Record<string, unknown>;

function metrics(row: Row): ProviderUsageMetrics {
  const inputTokens = Number(row.inputTokens ?? 0);
  const cacheReadTokens = Number(row.cacheReadTokens ?? 0);
  return {
    requestCount: Number(row.requestCount ?? 0),
    successCount: Number(row.successCount ?? 0),
    errorCount: Number(row.errorCount ?? 0),
    cancelledCount: Number(row.cancelledCount ?? 0),
    retryCount: Number(row.retryCount ?? 0),
    knownUsageRequests: Number(row.knownUsageRequests ?? 0),
    totalTokens: Number(row.totalTokens ?? 0),
    inputTokens,
    outputTokens: Number(row.outputTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
    cacheHitRate: inputTokens > 0 ? Math.min(1, cacheReadTokens / inputTokens) : null,
    avgTimeToFirstTokenMs:
      row.avgTimeToFirstTokenMs == null ? null : Number(row.avgTimeToFirstTokenMs),
    avgDurationMs: row.avgDurationMs == null ? null : Number(row.avgDurationMs),
  };
}
function channel(row: Row): string | null {
  return typeof row.authChannelId === "string"
    ? row.authChannelId
    : String(row.providerId).startsWith("oauth:")
      ? String(row.providerId).slice(6)
      : null;
}
function errorCode(value: unknown, status: unknown): string | null {
  if (status !== "error") return null;
  // 上游 error_code 也可能携带私有内容，统计只返回固定分类，不回传原文。
  if (/^(429|rate_limit_exceeded|rate_limit|rate_limited)$/iu.test(String(value)))
    return "rate_limited";
  if (/^(401|403|authentication_error|invalid_api_key)$/iu.test(String(value)))
    return "authentication_failed";
  if (/^(context_length_exceeded|context_exceeded)$/iu.test(String(value)))
    return "context_exceeded";
  if (/^(timeout|ETIMEDOUT)$/iu.test(String(value))) return "timeout";
  return "request_failed";
}

/** 同一 CLI UsageStore 的只读聚合；所有用户筛选绑定参数，不读取凭据或当前活动账号。 */
export async function queryProviderUsage(
  db: DatabaseSync,
  input: ProviderUsageQueryInput,
): Promise<ProviderUsageSnapshot> {
  const { since, until, ...raw } = input;
  const request = providerUsageRequestSchema.parse(raw);
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since < 0 ||
    until < since ||
    (request.range !== "all" && until - since > 31 * USAGE_DAY_MS)
  )
    throw new Error("Invalid usage interval");
  const timeZone = request.timeZone ?? "UTC";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const date = (value: number) => {
    const parts = formatter.formatToParts(value);
    return ["year", "month", "day"]
      .map((part) => parts.find((item) => item.type === part)!.value)
      .join("-");
  };
  // 直接用 IANA 时区计算每条记录日期，跨 DST 不沿用查询时刻的固定偏移。
  db.function("lcode_oauth_usage_day", { deterministic: true }, (value) => date(Number(value)));
  const clauses = [
    "provider_id like 'oauth:%'",
    "status != 'running'",
    "started_at >= ?",
    "started_at <= ?",
  ];
  const values: SQLInputValue[] = [since, until];
  for (const [column, value] of [
    ["provider_id", request.providerId],
    ["model_id", request.modelId],
  ] as const)
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  if (request.connectionId === null) clauses.push("account_connection_id is null");
  else if (request.connectionId !== undefined) {
    clauses.push("account_connection_id = ?");
    values.push(request.connectionId);
  }
  const where = clauses.join(" and ");
  const summary = metrics(
    db.prepare(`select ${aggregate} from model_usage where ${where}`).get(...values)!,
  );
  function groups(
    columns: "provider_id" | "provider_id, account_connection_id" | "provider_id, model_id",
  ) {
    const account = columns.includes("account_connection_id") ? "account_connection_id" : "null";
    const model = columns.includes("model_id") ? "model_id" : "null";
    return db
      .prepare(`select provider_id as providerId, max(auth_channel_id) as authChannelId,
      ${account} as accountConnectionId, ${model} as modelId, ${aggregate}
      from model_usage where ${where} group by ${columns} order by totalTokens desc, provider_id asc`)
      .all(...values)
      .map((row) => ({
        ...metrics(row),
        providerId: String(row.providerId),
        authChannelId: channel(row),
        accountConnectionId: row.accountConnectionId as string | null,
        modelId: row.modelId as string | null,
      }));
  }
  const days = db
    .prepare(`select lcode_oauth_usage_day(started_at) as date, ${aggregate}
    from model_usage where ${where} group by date order by date`)
    .all(...values);
  const observedDays = days.map((row) => ({ date: String(row.date), ...metrics(row) }));
  const calendar = providerUsageCalendar(
    observedDays,
    request.range === "all" ? (observedDays[0]?.date ?? date(until)) : date(since),
    date(until),
    () => metrics({}),
  );
  // 一轮可能调用多个OAuth账号或API；EXISTS关联避免重复累计turn时长，删除账号不参与此查询。
  const longest = db
    .prepare(`with selected_requests as (
    select session_id, turn_id from model_usage where ${where}
  ) select max(sessionDurationMs) as longestSessionMs from (
    select sum(t.duration_ms) as sessionDurationMs from turn_usage t
    where t.status = 'completed' and t.duration_ms >= 0 and exists (
      select 1 from selected_requests m where m.session_id = t.session_id and m.turn_id = t.turn_id
    ) group by t.session_id
  )`)
    .get(...values)!;
  const dailyModels = db
    .prepare(`select lcode_oauth_usage_day(started_at) as date,
    provider_id as providerId, max(auth_channel_id) as authChannelId,
    null as accountConnectionId, model_id as modelId, ${aggregate}
    from model_usage where ${where}
    group by date, provider_id, model_id order by date, provider_id, model_id`)
    .all(...values)
    .map((row) => ({
      ...metrics(row),
      date: String(row.date),
      providerId: String(row.providerId),
      authChannelId: channel(row),
      accountConnectionId: null,
      modelId: String(row.modelId),
    }));
  const requests = db
    .prepare(`select id, session_id as sessionId, provider_id as providerId,
    auth_channel_id as authChannelId, account_connection_id as accountConnectionId,
    model_id as modelId, query_source as querySource, status, started_at as startedAt,
    duration_ms as durationMs, time_to_first_token_ms as timeToFirstTokenMs,
    case when usage_known = 1 then computed_total_tokens else null end as totalTokens,
    case when usage_known = 1 then input_tokens else null end as inputTokens,
    case when usage_known = 1 then output_tokens else null end as outputTokens,
    retry_count as retryCount, error_code as errorCode from model_usage where ${where}
    order by started_at desc, id desc limit ? offset ?`)
    .all(...values, request.limit, request.offset)
    .map((row) => ({
      ...row,
      authChannelId: channel(row),
      errorCode: errorCode(row.errorCode, row.status),
    }));
  return providerUsageSnapshotSchema.parse({
    source: "agent-db",
    range: request.range,
    generatedAt: until,
    since,
    until,
    timeZone,
    retentionDays: 30,
    summary,
    daily: calendar.daily,
    dailyModels,
    activity: providerUsageActivity(
      observedDays,
      date(until),
      longest.longestSessionMs == null ? null : Number(longest.longestSessionMs),
      calendar.truncated,
    ),
    providers: groups("provider_id"),
    accounts: groups("provider_id, account_connection_id"),
    models: groups("provider_id, model_id"),
    requests,
    totalRequests: summary.requestCount,
    offset: request.offset,
    limit: request.limit,
  });
}
