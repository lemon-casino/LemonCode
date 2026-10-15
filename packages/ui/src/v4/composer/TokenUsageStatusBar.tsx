import { useState, type ReactNode, type CSSProperties } from "react";
import { Activity, ArrowDownUp, Bot, Clock3, Database, Layers } from "lucide-react";
import { DEFAULT_TOKEN_USAGE_STATUS_BAR, type TokenUsageStatusBarSettings } from "@lcode/shared";
import type { ConversationSnapshot, SessionUsageState } from "@lcode/shared/lcode-protocol-v4";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { SessionOutputSpeedValue } from "./SessionOutputSpeedValue.js";
import { combineOutputSpeeds, type SessionOutputSpeed } from "./sessionOutputSpeed.js";
import type { ChildSessionUsage } from "./sessionTokenStats.js";
import { readStatusBarRequest, readStatusBarTotals } from "./tokenUsageStatusBarModel.js";
import {
  DetailRow,
  UsageMetric,
  type UsageTone,
  type UsageMetricOpenMode,
} from "./TokenUsageMetric.js";
import "./tokenUsageStatusBar.css";

const EMPTY_SPEED: SessionOutputSpeed = { liveRate: null, average: null, pending: false };

export interface TokenUsageStatusBarProps {
  snapshot?: ConversationSnapshot | null;
  usage?: SessionUsageState | null;
  outputSpeed?: SessionOutputSpeed;
  childUsage?: ChildSessionUsage;
  childCount?: number;
  childCurrentOutputTokens?: number | null;
  childOutputSpeed?: SessionOutputSpeed;
  preferences?: TokenUsageStatusBarSettings;
  contextControl?: ReactNode;
}

/** 仅呈现同一会话投影；不建账本，不订阅、不轮询，也不持有布局以外的状态。 */
export function TokenUsageStatusBar({
  snapshot,
  usage = snapshot?.usage,
  outputSpeed = EMPTY_SPEED,
  childUsage,
  childCount = 0,
  childCurrentOutputTokens,
  childOutputSpeed = EMPTY_SPEED,
  preferences = DEFAULT_TOKEN_USAGE_STATUS_BAR,
  contextControl,
}: TokenUsageStatusBarProps) {
  const { intl, locale } = useLCodeIntl();
  const [openMetric, setOpenMetric] = useState<{
    id: UsageTone;
    mode: Exclude<UsageMetricOpenMode, null>;
  } | null>(null);
  const text = (key: string) => intl.formatMessage({ id: `chat.tokenUsageStatusBar.${key}` });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const compact = (value: number) => formatCompactTokenNumber(locale, value);
  const totals = readStatusBarTotals(
    usage?.cumulative,
    childUsage,
    usage?.contextWindow?.usedTokens,
  );
  const speed = combineOutputSpeeds([outputSpeed, childOutputSpeed]);
  const request = readStatusBarRequest(snapshot);
  const hasSpeed = speed.liveRate !== null || speed.average !== null || speed.pending;
  const cacheRead = usage?.cumulative.cacheReadTokens;
  const cacheWrite = usage?.cumulative.cacheWriteTokens;
  const cacheAvailable = totals.own !== null && Number.isFinite(cacheRead) && cacheRead! >= 0;
  const hasCache = cacheAvailable && (cacheRead! > 0 || (cacheWrite ?? 0) > 0);
  const hasSession = Boolean(usage && preferences.session);
  const hasContext = Boolean(preferences.context && contextControl);
  if (
    !preferences.enabled ||
    !(
      hasSession ||
      hasContext ||
      (preferences.speed && hasSpeed) ||
      (preferences.cache && hasCache) ||
      (preferences.subagents && childCount > 0) ||
      (preferences.request && request)
    )
  )
    return null;
  const metricProps = (id: UsageTone) => ({
    id,
    openMode: openMetric?.id === id ? openMetric.mode : null,
    // 前一个浮层的迟到关闭只能清理自身，不能关掉用户刚打开的另一个指标。
    onOpenModeChange: (mode: UsageMetricOpenMode) =>
      setOpenMetric((current) => (mode ? { id, mode } : current?.id === id ? null : current)),
  });
  const speedDetails = (value: SessionOutputSpeed) => (
    <div className="token-usage-speed-detail token-usage-tone" data-usage-tone="speed">
      <SessionOutputSpeedValue speed={value} intl={intl} locale={locale} />
    </div>
  );
  const mainDetails = (
    <div
      className="token-usage-detail-group token-usage-tone space-y-2 rounded-lg p-2"
      data-usage-tone="session"
    >
      <div className="text-ui-xs font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "chat.sessionUsage.mainGroup" })}
      </div>
      <DetailRow tone="context" label={intl.formatMessage({ id: "chat.sessionUsage.mainInput" })}>
        {totals.own === null ? "—" : number(usage?.cumulative.inputTokens ?? 0)}
      </DetailRow>
      <DetailRow tone="speed" label={intl.formatMessage({ id: "chat.sessionUsage.mainOutput" })}>
        {totals.own === null ? "—" : number(usage?.cumulative.outputTokens ?? 0)}
      </DetailRow>
      {speedDetails(outputSpeed)}
    </div>
  );
  const childDetails = (
    <div
      className="token-usage-detail-group token-usage-tone space-y-2 rounded-lg p-2"
      data-usage-tone="subagents"
    >
      <div className="text-ui-xs font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "chat.sessionUsage.childGroup" }, { count: childCount })}
      </div>
      <DetailRow tone="subagents" label={intl.formatMessage({ id: "chat.sessionUsage.subagents" })}>
        {childUsage?.unknownCount ? "≥" : ""}
        {number(totals.children)}
      </DetailRow>
      {childUsage?.unknownCount ? (
        <p className="text-foreground-subtle">{text("partial")}</p>
      ) : null}
      {childCurrentOutputTokens != null ? (
        <DetailRow
          tone="context"
          label={intl.formatMessage({ id: "chat.sessionUsage.childCurrentOutput" })}
        >
          {number(childCurrentOutputTokens)}
        </DetailRow>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-foreground-subtle">
          {intl.formatMessage({ id: "chat.sessionUsage.childSpeed" })}
        </span>
        {speedDetails(childOutputSpeed)}
      </div>
    </div>
  );
  return (
    <div
      className="token-usage-statusbar flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-ui-xs text-foreground-subtle"
      role="group"
      aria-label={text("title")}
      data-testid="token-usage-statusbar"
      data-placement={preferences.position}
      data-animated={preferences.animations}
      data-active={speed.liveRate !== null}
      data-open-metric={openMetric?.id ?? ""}
      style={
        {
          "--token-usage-rate-scale": Math.min(1, 0.55 + (speed.liveRate ?? 0) / 200),
        } as CSSProperties
      }
    >
      {preferences.speed && hasSpeed ? (
        <UsageMetric
          {...metricProps("speed")}
          label={text("speed")}
          icon={
            <span
              className="token-usage-activity inline-flex h-3.5 items-center gap-0.5"
              aria-hidden="true"
            >
              {speed.liveRate !== null ? (
                [0, 1, 2, 3].map((index) => (
                  <i
                    key={index}
                    className="token-usage-wave w-0.5 rounded-sm bg-current"
                    style={{ "--wave-index": index } as CSSProperties}
                  />
                ))
              ) : (
                <Activity className="size-3.5" />
              )}
            </span>
          }
          value={<SessionOutputSpeedValue speed={speed} intl={intl} locale={locale} compact />}
        >
          {mainDetails}
          {childCount > 0 ? (
            <div className="border-t border-border pt-3">{childDetails}</div>
          ) : null}
        </UsageMetric>
      ) : null}
      {hasContext ? (
        <div
          className="token-usage-context token-usage-tone inline-flex min-w-0 items-center"
          data-usage-tone="context"
        >
          {contextControl}
        </div>
      ) : null}
      {hasSession ? (
        <UsageMetric
          {...metricProps("session")}
          label={text("session")}
          icon={<Layers className="size-3.5" />}
          value={
            totals.total === null
              ? "—"
              : totals.total === 0
                ? text("pending")
                : `${totals.partial ? "≥" : ""}${compact(totals.total)}`
          }
        >
          <DetailRow
            tone="session"
            label={intl.formatMessage({
              id: totals.partial ? "chat.sessionUsage.partialTitle" : "chat.sessionUsage.title",
            })}
          >
            {totals.total === null ? "—" : `${totals.partial ? "≥" : ""}${number(totals.total)}`}
          </DetailRow>
          {mainDetails}
          {childCount > 0 ? (
            <div className="border-t border-border pt-3">{childDetails}</div>
          ) : null}
          <p className="text-ui-xs text-foreground-subtle">{text("accounting")}</p>
        </UsageMetric>
      ) : null}
      {preferences.cache && hasCache ? (
        <UsageMetric
          {...metricProps("cache")}
          label={text("cache")}
          icon={<Database className="size-3.5" />}
          value={compact(cacheRead!)}
        >
          <DetailRow tone="cache" label={text("cacheRead")}>
            {number(cacheRead!)}
          </DetailRow>
          <DetailRow tone="session" label={text("cacheWrite")}>
            {Number.isFinite(cacheWrite) && cacheWrite! >= 0 ? number(cacheWrite!) : "—"}
          </DetailRow>
          <p className="text-ui-xs text-foreground-subtle">{text("accounting")}</p>
        </UsageMetric>
      ) : null}
      {preferences.request && request ? (
        <UsageMetric
          {...metricProps("request")}
          label={text("request")}
          icon={<Clock3 className="size-3.5" />}
          value={`${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(request.durationMs / 1000)}s`}
        >
          <DetailRow tone="speed" label={text("requestOutput")}>
            {number(request.outputTokens)}
          </DetailRow>
          <DetailRow tone="request" label={text("requestDuration")}>
            {number(request.durationMs)} ms
          </DetailRow>
          <p className="text-ui-xs text-foreground-subtle">{text("requestScope")}</p>
        </UsageMetric>
      ) : null}
      {preferences.subagents && childCount > 0 ? (
        <UsageMetric
          {...metricProps("subagents")}
          label={text("subagents")}
          icon={<Bot className="size-3.5" />}
          value={
            <span className="inline-flex items-center gap-1.5">
              {childOutputSpeed.liveRate !== null || childOutputSpeed.pending ? (
                <span
                  className="token-usage-live-dot size-1.5 rounded-full bg-brand"
                  aria-hidden="true"
                />
              ) : null}
              {childCount}
              <ArrowDownUp className="size-3" aria-hidden="true" />
              {childUsage?.unknownCount ? "≥" : ""}
              {compact(totals.children)}
            </span>
          }
        >
          {childDetails}
        </UsageMetric>
      ) : null}
    </div>
  );
}
