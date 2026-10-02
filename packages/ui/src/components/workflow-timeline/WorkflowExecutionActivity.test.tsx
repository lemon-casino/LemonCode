import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkflowAgentPill } from "./WorkflowAgentPill.js";
import type { WorkflowActivitySummary, WorkflowPillActivity } from "./timeline-activity.js";
import {
  throttleReasonLabel,
  workflowRunConcurrencyEventLine,
} from "@/app-shell/workflowRunThrottle.js";
import {
  WorkflowActivityDetails,
  workflowActivitySummaryText,
} from "./WorkflowExecutionActivity.js";

function render(
  activity: WorkflowPillActivity,
  locale: "zh-CN" | "en-US" = "zh-CN",
  size: "md" | "row" = "md",
) {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale={locale}>
      <WorkflowAgentPill
        name="Reader"
        laneClass="agent"
        status="running"
        size={size}
        activity={activity}
        activityNow={1_000}
        open={{ onOpen: () => {}, label: "Open transcript" }}
      />
    </LCodeIntlProvider>,
  );
}

test("regular and dense pills expose separate clickable activity details and keep transcript opening", () => {
  for (const size of ["md", "row"] as const) {
    const html = render({ kind: "model" }, "zh-CN", size);
    assert.match(html, /模型处理中/);
    assert.match(html, /data-testid="workflow-activity-open"/);
    assert.match(html, /aria-label="Open transcript"/);
    assert.equal((html.match(/<button\b/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    assert.doesNotMatch(html, /正在输出思考|0 token/);
  }
});

test("first retry and visible output are localized without a fake retry budget", () => {
  const retry = {
    kind: "backoff" as const,
    retryNumber: 1,
    nextRetryAt: 6_000,
    reason: "rate_limited",
  };
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = render(retry, locale);
    assert.match(html, locale === "zh-CN" ? /第 1 次重试/ : /Retry 1/);
    assert.doesNotMatch(html, /最多 0|max(?:imum)? 0|deadlock|死锁/);
    assert.match(
      render({ kind: "reasoning" }, locale),
      locale === "zh-CN" ? /正在输出思考/ : /Streaming reasoning/,
    );
    assert.match(render({ kind: "tool", toolName: "Read" }, locale), /Read/);
  }
});

test("retry reasons distinguish rate limits, network and stream failures without raw errors", () => {
  const format = ({ id }: { id: string }) => id;
  assert.notEqual(
    throttleReasonLabel("network_error", format),
    throttleReasonLabel("stream_idle_timeout", format),
  );
  assert.notEqual(
    throttleReasonLabel("timeout", format),
    throttleReasonLabel("server_error", format),
  );
  assert.doesNotMatch(
    throttleReasonLabel("sensitive provider message", format),
    /sensitive provider/,
  );
  const html = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <WorkflowActivityDetails
        activity={{
          kind: "backoff",
          retryNumber: 1,
          reason: "stream_idle_timeout",
          nextRetryAt: 6_000,
          observedAt: 500,
          requestsCompleted: 2,
          toolCalls: 3,
        }}
        now={1_000}
      />
    </LCodeIntlProvider>,
  );
  assert.match(html, /流式输出中断/);
  assert.match(html, /预计 5 秒后继续/);
  assert.match(html, /最近活动|成功请求数|工具调用数/);
  assert.doesNotMatch(html, /本次已交付/);
});

test("waiting details explain a concurrent tool without replacing retry or slot facts", () => {
  for (const kind of ["slot", "backoff"] as const) {
    const html = renderToStaticMarkup(
      <LCodeIntlProvider initialLocale="zh-CN">
        <WorkflowActivityDetails
          activity={{ kind, toolName: "Read", retryNumber: 1, nextRetryAt: 6_000 }}
          now={1_000}
        />
      </LCodeIntlProvider>,
    );
    assert.match(html, /正在执行工具：Read/);
    assert.match(html, kind === "slot" ? /等待并发槽位/ : /第 1 次重试/);
    assert.equal((html.match(/data-testid="workflow-activity-concurrent-tool"/g) ?? []).length, 1);
  }
});

test("unknown and ended pills have no invented successful requests or retry countdown", () => {
  for (const kind of ["unknown", "paused", "ended"] as const) {
    const html = render({ kind });
    assert.doesNotMatch(html, /正在输出|后重试|0 次成功|0 requests/);
  }
});

function Summary({ value }: { value: WorkflowActivitySummary }) {
  const { intl } = useLCodeIntl();
  return <span>{workflowActivitySummaryText(value, intl.formatMessage)}</span>;
}

test("summary groups are localized, count all actors and bound the visible list", () => {
  const value: WorkflowActivitySummary = {
    groups: [
      { kind: "model", count: 2 },
      { kind: "backoff", count: 1 },
      { kind: "run-capacity", count: 1 },
      { kind: "paused", count: 4 },
    ],
    total: 8,
    truncated: true,
  };
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderToStaticMarkup(
      <LCodeIntlProvider initialLocale={locale}>
        <Summary value={value} />
      </LCodeIntlProvider>,
    );
    assert.match(
      html,
      locale === "zh-CN" ? /2 位代理：模型处理中/ : /2 agents: Model request in progress/,
    );
    assert.match(html, locale === "zh-CN" ? /1 位代理：退避重试中/ : /1 agent: Waiting to retry/);
    assert.match(html, locale === "zh-CN" ? /另 4 位代理/ : /4 more agents/);
    assert.match(html, locale === "zh-CN" ? /仅已观察窗口/ : /Observed window only/);
    assert.doesNotMatch(html, /\{count|预计|Expected to continue/);
    const syncing = renderToStaticMarkup(
      <LCodeIntlProvider initialLocale={locale}>
        <Summary value={{ ...value, connection: "syncing" }} />
      </LCodeIntlProvider>,
    );
    assert.match(syncing, locale === "zh-CN" ? /同步中/ : /Syncing/);
    assert.doesNotMatch(syncing, /模型处理中|Model request in progress|Waiting to retry/);
  }
});

test("admission journal lines reuse the same queue labels without inventing a cause", () => {
  const format = ({ id }: { id: string }) => id;
  for (const cause of ["actor-fifo", "run-capacity"] as const) {
    const line = workflowRunConcurrencyEventLine(
      {
        sequence: 1,
        type: "node-admission",
        payload: { cause, instance: { siteId: "ask#1", ordinal: 1 } },
      },
      format,
    );
    assert.equal(line?.label, `chat.toolCall.workflow.activity.${cause}`);
    assert.equal(line?.detail, "ask#1@1");
  }
  assert.equal(
    workflowRunConcurrencyEventLine({ sequence: 2, type: "node-admission", payload: {} }, format)
      ?.label,
    "chat.toolCall.workflow.activity.queued",
  );
  assert.equal(
    workflowRunConcurrencyEventLine(
      { sequence: 3, type: "node-admission", payload: { cause: null } },
      format,
    )?.label,
    "chat.toolCall.workflow.activity.dispatched",
  );
});

function details(activity: WorkflowPillActivity, now: number, locale: "zh-CN" | "en-US") {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale={locale}>
      <WorkflowActivityDetails activity={activity} now={now} />
    </LCodeIntlProvider>,
  );
}

test("wait origin and elapsed time share the caller clock and coexist with observed statistics", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const kind of ["actor-fifo", "run-capacity", "slot", "backoff"] as const) {
      const activity: WorkflowPillActivity = {
        kind,
        since: 1_000,
        retryNumber: 1,
        nextRetryAt: 12_000,
        toolName: kind === "slot" || kind === "backoff" ? "Read" : undefined,
        observedAt: 2_000,
        lastRequestCompletedAt: 500,
        deliveredAt: 0,
        requestsCompleted: 2,
        toolCalls: 3,
      };
      const first = details(activity, 6_000, locale);
      assert.match(first, /data-testid="workflow-activity-waitSince"/);
      // React 静态输出保留 dateTime 大写 T，HTML 属性名不区分大小写；源时间仍须精确匹配。
      assert.match(first, /date[Tt]ime="1970-01-01T00:00:01\.000Z"/);
      assert.match(first, /data-testid="workflow-activity-waitedFor"[^>]*>5s</);
      assert.match(
        details(activity, 8_000, locale),
        /data-testid="workflow-activity-waitedFor"[^>]*>7s</,
      );
      for (const fact of [
        "observedAt",
        "lastRequestCompletedAt",
        "deliveredAt",
        "requestsCompleted",
        "toolCalls",
      ]) {
        assert.match(first, new RegExp(`data-testid="workflow-activity-${fact}"`));
      }
      assert.match(first, locale === "zh-CN" ? /已观察的最近交付/ : /Latest observed delivery/);
      if (kind === "slot" || kind === "backoff") assert.match(first, /Read/);
    }
  }
});

test("tool start is not a wait and elapsed time never continues for ended, paused or syncing observations", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const tool = details({ kind: "tool", toolName: "Read", since: 1_000 }, 6_000, locale);
    assert.match(tool, /data-testid="workflow-activity-toolSince"/);
    assert.match(tool, /data-testid="workflow-activity-toolElapsed"[^>]*>5s</);
    assert.doesNotMatch(tool, /data-testid="workflow-activity-waitedFor"/);
    for (const patch of [
      { kind: "ended" as const },
      { kind: "paused" as const },
      { connection: "syncing" as const },
      { connection: "stale" as const },
    ]) {
      const activity: WorkflowPillActivity = {
        kind: "backoff",
        since: 1_000,
        nextRetryAt: 12_000,
        ...patch,
      };
      const before = details(activity, 6_000, locale);
      assert.equal(details(activity, 20_000, locale), before);
      assert.doesNotMatch(
        before,
        /workflow-activity-(?:waitedFor|toolElapsed|nextRetryAt)|预计|Expected to continue/,
      );
    }
    assert.doesNotMatch(
      details({ kind: "slot" }, 6_000, locale),
      /workflow-activity-wait(?:Since|edFor)/,
    );
  }
});
