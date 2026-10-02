import { Fragment } from "react";
import { InfoIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { throttleReasonLabel } from "@/app-shell/workflowRunThrottle.js";
import { useLCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge } from "@/lib/workflowObservationFormat.js";
import type { WorkflowActivitySummary, WorkflowPillActivity } from "./timeline-activity.js";

const PREFIX = "chat.toolCall.workflow.activity.";

export function workflowActivityText(
  activity: WorkflowPillActivity,
  format: IntlInstance["formatMessage"],
  now: number | undefined,
  compact = false,
): string {
  if (activity.connection !== undefined) return format({ id: `${PREFIX}unknown` });
  if (activity.kind === "backoff") {
    const retry =
      activity.retryNumber === undefined
        ? format({ id: `${PREFIX}backoff` })
        : format({ id: `${PREFIX}retry` }, { count: activity.retryNumber });
    if (compact || activity.nextRetryAt === undefined || now === undefined) return retry;
    const seconds = Math.max(0, Math.ceil((activity.nextRetryAt - now) / 1_000));
    return `${retry} · ${format(
      { id: `${PREFIX}${seconds > 0 ? "retryIn" : "retryDue"}` },
      { seconds },
    )}`;
  }
  if (activity.kind === "tool") {
    return activity.toolName === undefined
      ? format({ id: `${PREFIX}toolUnknown` })
      : format({ id: `${PREFIX}tool` }, { name: activity.toolName });
  }
  return format({
    id: `${PREFIX}${activity.kind === "model" && compact ? "modelShort" : activity.kind}`,
  });
}

/** 起点和时长的规则共用；静态卡不传生成时刻时只显示源时间，不补浏览器时钟。 */
export function workflowActivityTiming(activity: WorkflowPillActivity, now: number | undefined) {
  if (activity.connection !== undefined || activity.since === undefined) return undefined;
  const waiting = activity.kind === "slot" || activity.kind === "backoff" ||
    activity.kind === "actor-fifo" || activity.kind === "run-capacity" || activity.kind === "question";
  if (!waiting && activity.kind !== "tool") return undefined;
  return {
    since: activity.since,
    sinceKey: waiting ? "waitSince" : "toolSince",
    elapsedKey: waiting ? "waitedFor" : "toolElapsed",
    elapsed: formatWorkflowAge(now, activity.since),
  };
}

/** 只限制摘要组数，不抽一个随机 actor；其余 actor 的数量明确保留，详情仍走原入口。 */
export function workflowActivitySummaryText(
  summary: WorkflowActivitySummary,
  format: IntlInstance["formatMessage"],
): string {
  if (summary.connection !== undefined) return format({ id: `${PREFIX}${summary.connection}` });
  if (summary.total === 0) return workflowActivityText({ kind: "not-started" }, format, undefined, true);
  const groups = summary.groups.slice(0, 3);
  const text = groups.map(({ kind, count }) => format(
    { id: `${PREFIX}${count === 1 ? "summaryGroupOne" : "summaryGroup"}` },
    { count, activity: workflowActivityText({ kind }, format, undefined, true) },
  ));
  const remaining = summary.total - groups.reduce((count, group) => count + group.count, 0);
  if (remaining > 0) text.push(format({ id: `${PREFIX}summaryMore` }, { count: remaining }));
  if (summary.truncated) text.push(format({ id: `${PREFIX}summaryObserved` }));
  return text.join(" · ");
}

/** 事实明细与点击入口共用；时间只由父级秒针驱动，不为每个 actor 建 timer/lease。 */
export function WorkflowActivityDetails({
  activity,
  now,
}: {
  activity: WorkflowPillActivity;
  now: number;
}) {
  const { intl, locale } = useLCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const date = (timestamp: number) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(timestamp);
  const entries: { key: string; value: string; timestamp?: number }[] = [];
  const timing = workflowActivityTiming(activity, now);
  if (timing !== undefined) {
    entries.push({ key: timing.sinceKey, value: date(timing.since), timestamp: timing.since });
    if (timing.elapsed !== undefined) entries.push({ key: timing.elapsedKey, value: timing.elapsed });
  }
  for (const [key, timestamp] of [
    ["observedAt", activity.observedAt],
    ["lastRequestCompletedAt", activity.lastRequestCompletedAt],
    ["deliveredAt", activity.deliveredAt],
    ["nextRetryAt", activity.connection === undefined && activity.kind === "backoff" ? activity.nextRetryAt : undefined],
  ] as const) {
    if (timestamp !== undefined) entries.push({ key, value: date(timestamp), timestamp });
  }
  if (activity.requestsCompleted !== undefined)
    entries.push({ key: "requestsCompleted", value: String(activity.requestsCompleted) });
  if (activity.toolCalls !== undefined)
    entries.push({ key: "toolCalls", value: String(activity.toolCalls) });
  return (
    <div
      className="min-w-0 space-y-2 text-ui-sm"
      data-testid="workflow-activity-details"
      data-activity-kind={activity.kind}
    >
      <p className="break-words text-foreground">{workflowActivityText(activity, format, now)}</p>
      {activity.connection === undefined ? null : (
        <WorkflowConnectionNotice connection={activity.connection} />
      )}
      {activity.connection === undefined &&
      (activity.kind === "slot" || activity.kind === "backoff") &&
      activity.toolName !== undefined ? (
        <p
          className="break-words text-foreground-subtle"
          data-testid="workflow-activity-concurrent-tool"
        >
          {format({ id: `${PREFIX}tool` }, { name: activity.toolName })}
        </p>
      ) : null}
      {activity.reason === undefined ? null : (
        <p className="break-words text-foreground-subtle" data-testid="workflow-activity-reason">
          {format({ id: `${PREFIX}reason` })}
          {" · "}
          {throttleReasonLabel(activity.reason, format)}
        </p>
      )}
      {entries.length === 0 ? null : (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-foreground-subtle">
          {entries.map(({ key, value, timestamp }) => (
            <Fragment key={key}>
              <dt>{format({ id: `${PREFIX}${key}` })}</dt>
              <dd
                className="min-w-0 break-words text-right tabular-nums"
                data-testid={`workflow-activity-${key}`}
              >
                {timestamp === undefined ? (
                  value
                ) : (
                  <time dateTime={new Date(timestamp).toISOString()}>{value}</time>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

export function WorkflowExecutionActivity({
  activity,
  name,
  now,
}: {
  activity: WorkflowPillActivity;
  name: string;
  now: number;
}) {
  const { intl } = useLCodeIntl();
  const label = intl.formatMessage({ id: `${PREFIX}open` }, { name });
  return (
    <Popover>
      {/* 独立于 transcript 药丸的兄弟按钮；手机可点，不能把详情按钮嵌在药丸按钮内。 */}
      <PopoverTrigger asChild>
        <button
          aria-label={label}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-subtle outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="workflow-activity-open"
          title={label}
          type="button"
        >
          <InfoIcon aria-hidden className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={label}
        className="w-80 max-w-[calc(100vw-2rem)] gap-2"
        collisionPadding={16}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <p className="min-w-0 break-words text-ui-sm font-medium text-foreground">{name}</p>
        <WorkflowActivityDetails activity={activity} now={now} />
      </PopoverContent>
    </Popover>
  );
}

export function WorkflowConnectionNotice({
  connection,
}: {
  connection: "syncing" | "stale" | undefined;
}) {
  const { intl } = useLCodeIntl();
  if (connection === undefined) return null;
  return (
    <p
      className="min-w-0 break-words text-ui-sm text-foreground-subtle"
      role="status"
      data-testid="workflow-connection-notice"
    >
      {intl.formatMessage({ id: `${PREFIX}${connection}` })}
    </p>
  );
}
