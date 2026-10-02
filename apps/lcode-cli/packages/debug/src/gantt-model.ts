import type {
  DataGroup as VisTimelineGroup,
  DataItem as VisTimelineItem,
  TimelineOptions,
} from "vis-timeline/standalone";
import type { NetworkRequestRecord, TraceSpan, TraceSpanLane } from "./shared";
import { ganttItemStyle } from "./gantt-style";
import {
  formatSpanStatus,
  formatSpanDuration,
  formatNetworkStatus,
  formatDuration,
} from "./debug-format";

const laneOrder: TraceSpanLane[] = [
  "turn",
  "model",
  "tool",
  "permission",
  "subagent",
  "network",
  "storage",
  "log",
  "event",
];

export const laneLabels: Record<TraceSpanLane, string> = {
  turn: "Turn",
  model: "模型",
  tool: "工具",
  network: "网络",
  permission: "权限",
  storage: "存储",
  subagent: "子 Agent",
  event: "事件",
  log: "日志",
};

export function buildGanttGroups(spans: TraceSpan[]): VisTimelineGroup[] {
  const activeLanes = new Set(spans.map((span) => span.lane));
  return laneOrder
    .filter((lane) => activeLanes.has(lane))
    .map((lane, index) => ({
      id: lane,
      content: laneLabels[lane],
      order: index,
      className: `gantt-group lane-${lane}`,
    }));
}

export function buildGanttItems(spans: TraceSpan[]): VisTimelineItem[] {
  return spans.map((span) => {
    const runningEndAt =
      !span.endAt && span.status === "running" ? new Date().toISOString() : undefined;
    const type = span.endAt || runningEndAt ? "range" : "point";
    return {
      id: span.id,
      group: span.lane,
      content: ganttItemContent(span),
      title: escapeTimelineContent(ganttItemTitle(span)),
      start: span.startAt,
      end: span.endAt ?? runningEndAt,
      type,
      style: ganttItemStyle(type),
      className: `gantt-item lane-${span.lane} span-status-${span.status}`,
    };
  });
}

function ganttItemContent(span: TraceSpan): string {
  return [
    `<span class="gantt-item-title">${escapeTimelineContent(span.label)}</span>`,
    `<span class="gantt-item-meta"> · ${escapeTimelineContent(ganttItemMeta(span))}</span>`,
  ].join("");
}

function ganttItemTitle(span: TraceSpan): string {
  return [
    span.label,
    `${laneLabels[span.lane]} · ${formatSpanStatus(span.status)} · ${formatSpanDuration(span)}`,
    ganttIdentifierLine(span),
    span.summary,
  ]
    .filter(Boolean)
    .join("\n");
}

function ganttItemMeta(span: TraceSpan): string {
  const request = networkRequestFromPayload(span.payload);
  if (request) {
    return [formatNetworkStatus(request), formatDuration(request.durationMs)].join(" · ");
  }

  return [formatSpanStatus(span.status), formatSpanDuration(span)].join(" · ");
}

function ganttIdentifierLine(span: TraceSpan): string {
  return [
    span.traceId ? `trace ${span.traceId}` : "",
    span.sessionId ? `session ${span.sessionId}` : "",
    span.turnId ? `turn ${span.turnId}` : "",
    span.toolCallId ? `tool ${span.toolCallId}` : "",
    span.spanId ? `span ${span.spanId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function networkRequestFromPayload(payload: unknown): NetworkRequestRecord | null {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.id !== "string") return null;
  if (typeof payload.startedAt !== "string") return null;
  if (typeof payload.method !== "string") return null;
  if (typeof payload.url !== "string") return null;
  if (typeof payload.status !== "string") return null;
  return payload as unknown as NetworkRequestRecord;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ganttOptions(isFullscreen: boolean): TimelineOptions {
  return {
    stack: true,
    autoResize: true,
    selectable: true,
    showCurrentTime: false,
    horizontalScroll: true,
    verticalScroll: true,
    zoomKey: "ctrlKey",
    orientation: { axis: "top", item: isFullscreen ? "top" : "bottom" },
    margin: { item: { horizontal: 8, vertical: 8 }, axis: 12 },
    groupHeightMode: "fitItems",
    height: isFullscreen ? "100%" : undefined,
    minHeight: isFullscreen ? "0" : "320px",
    maxHeight: isFullscreen ? undefined : "560px",
  };
}

function escapeTimelineContent(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
