import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPanel } from "./context-panel";
import { CachePanel, GapsPanel } from "./cache-panel";
import { NetworkPage } from "./network-panel";
import { TimelinePanel } from "./timeline-panel";
import { buildGanttGroups, buildGanttItems } from "./gantt-model";
import { buildQuery, viewFromHash } from "./debug-view-model";
import {
  filterNetworkRequests,
  formatEnvCommand,
  mergeNetworkRequest,
  mergeNetworkSpans,
} from "./network-model";
import type { ContextSnapshotView, NetworkRequestRecord, TraceSpan } from "./shared";

const request: NetworkRequestRecord = {
  id: "request-fixture",
  traceId: "trace-fixture",
  sessionId: "session-fixture",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: "2026-01-01T00:00:02.000Z",
  durationMs: 1000,
  protocol: "https",
  method: "POST",
  host: "example.invalid",
  path: "/fixture",
  url: "https://example.invalid/fixture",
  status: "complete",
  statusCode: 201,
  requestHeaders: {},
  responseHeaders: {},
  requestHeaderCount: 0,
  responseHeaderCount: 0,
  requestBodyBytes: 16,
  responseBodyBytes: 32,
};

function snapshot(
  id: string,
  observationLevel: ContextSnapshotView["observationLevel"],
): ContextSnapshotView {
  return {
    id,
    observationLevel,
    totalChars: 8,
    totalTokens: 4,
    messageCount: 1,
    warnings: [],
    sections: [
      {
        id,
        name: id,
        source: "system_prompt",
        chars: 8,
        tokens: 4,
        percentTokens: 1,
        content: `content-${id}`,
        observable: "full",
      },
    ],
  };
}

test("context panel prefers the latest full snapshot and renders original section content", () => {
  const html = renderToStaticMarkup(
    <ContextPanel
      snapshots={[
        snapshot("older", "full"),
        snapshot("selected", "full"),
        snapshot("metadata", "metadata"),
      ]}
      usageSnapshots={[]}
    />,
  );
  assert.ok(html.includes("content-selected"));
  assert.ok(!html.includes("content-older"));
  assert.ok(!html.includes("content-metadata"));
  assert.ok(html.includes('aria-label="上下文 token 占比"'));
});

test("timeline and gap panels preserve payload rendering and accessible section content", () => {
  const html = renderToStaticMarkup(
    <TimelinePanel
      items={[
        {
          id: "fixture",
          source: "eventlog",
          kind: "fixture",
          label: "Fixture",
          summary: "fixture summary",
          sessionId: "session-fixture",
          payload: { field: "<fixture>" },
        },
      ]}
    />,
  );
  assert.ok(html.includes("fixture summary"));
  assert.ok(html.includes("原始 Payload"));
  assert.ok(html.includes("&lt;fixture&gt;"));
  assert.ok(html.includes("会话 session-fixture"));
  assert.ok(renderToStaticMarkup(<GapsPanel requests={[]} />).includes("当前 trace 没有观测缺口"));
  assert.ok(renderToStaticMarkup(<CachePanel reports={[]} />).includes("未观察到缓存使用"));
});

test("network panel filters by controlled props without changing rows or trace buttons", () => {
  const html = renderToStaticMarkup(
    <NetworkPage
      activeTraceId="trace-fixture"
      error={null}
      filter="  EXAMPLE.INVALID "
      onFilterChange={() => {}}
      onTraceSelect={() => {}}
      requests={[request]}
      status={null}
    />,
  );
  assert.ok(html.includes("network-row active"));
  assert.ok(html.includes("trace-fixture"));
  assert.ok(html.includes("201"));
  assert.ok(html.includes("16 B up"));
  assert.ok(html.includes("1.0 s"));
  assert.ok(html.includes('title="选择这个 Trace"'));
});

test("network projection keeps immutable input, newest-first retention and attribution", () => {
  const current = Array.from({ length: 201 }, (_, index) => ({
    ...request,
    id: `request-${index}`,
    startedAt: new Date(index * 1000).toISOString(),
  }));
  const next = { ...request, id: "request-100", startedAt: new Date(999_000).toISOString() };
  const merged = mergeNetworkRequest(current, next);
  assert.equal(current.length, 201);
  assert.equal(merged.length, 200);
  assert.equal(merged[0], next);
  assert.equal(merged.filter((item) => item.id === next.id).length, 1);
  assert.equal(filterNetworkRequests(current, " "), current);
  assert.deepEqual(filterNetworkRequests([request], "trace-fixture"), [request]);
  const spans: TraceSpan[] = [];
  assert.equal(mergeNetworkSpans(spans, [request], ""), spans);
  const projected = mergeNetworkSpans(
    spans,
    [request, { ...request, id: "other", traceId: "other" }],
    "trace-fixture",
  );
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.startAt, request.startedAt);
  assert.equal(projected[0]?.endAt, request.completedAt);
  assert.equal(projected[0]?.status, "ok");
});

test("gantt projection retains lane order and escapes user text without changing span time", () => {
  const networkSpan = mergeNetworkSpans([], [request], "trace-fixture")[0]!;
  const toolSpan: TraceSpan = {
    ...networkSpan,
    id: "tool",
    lane: "tool",
    label: '<script>"fixture"</script>',
    status: "unknown",
    endAt: undefined,
  };
  assert.deepEqual(
    buildGanttGroups([networkSpan, toolSpan]).map((group) => group.id),
    ["tool", "network"],
  );
  const items = buildGanttItems([toolSpan, networkSpan]);
  assert.equal(items[0]?.type, "point");
  assert.equal(items[0]?.start, toolSpan.startAt);
  assert.ok(String(items[0]?.content).includes("&lt;script&gt;&quot;fixture&quot;&lt;/script&gt;"));
  assert.equal(items[1]?.type, "range");
  assert.equal(items[1]?.end, request.completedAt);
});

test("shell env quoting, source query trimming and hash defaults stay unchanged", () => {
  assert.equal(formatEnvCommand({ FIXTURE: "a'b" }, "posix"), "export FIXTURE='a'\\''b'");
  assert.equal(formatEnvCommand({ FIXTURE: "a'b" }, "powershell"), "$env:FIXTURE = 'a''b'");
  assert.equal(formatEnvCommand({ FIXTURE: 'a"b' }, "cmd"), 'set "FIXTURE=a\\"b"');
  assert.equal(
    buildQuery({ projectId: " fixture ", logDir: "", eventPath: "", dbPath: "", sessionId: "" }),
    "?projectId=fixture",
  );
  assert.equal(viewFromHash("#network"), "network");
  assert.equal(viewFromHash("#gantt"), "gantt");
  assert.equal(viewFromHash("#trace"), "gantt");
});
