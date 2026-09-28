import type { ModelUsageSummary } from "@lcode/contracts";
import type { TuiCopy } from "@lcode/i18n";
import React from "react";
import type { NetworkRequest } from "./app-model.js";
import { palette } from "./app-model.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import { formatDuration } from "./state.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const SIDEBAR_LABEL_WIDTH = 9;
const SIDEBAR_ROW_VALUE_WIDTH = SIDEBAR_CONTENT_WIDTH - SIDEBAR_LABEL_WIDTH - 1;
const COMPACT_IDENTIFIER_PREFIX_LENGTH = 8;
const COMPACT_IDENTIFIER_SUFFIX_LENGTH = 4;
const UUID_IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDEBAR_TEXT_ROW_STYLE = { flexShrink: 0, height: 1, truncate: true, wrapMode: "none" };

export function ApiSection(props: {
  copy: TuiCopy;
  expanded: boolean;
  networkRequests: NetworkRequest[];
  onToggle?: () => void;
  usage?: ModelUsageSummary;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
      },
    },
    SidebarSectionHeader({
      expanded: props.expanded,
      onToggle: props.onToggle,
      title: props.copy.sidebar.sections.apis,
    }),
    ...(props.expanded ? apiLines(props) : []),
  );
}

function apiLines(props: {
  copy: TuiCopy;
  networkRequests: NetworkRequest[];
  usage?: ModelUsageSummary;
}): React.ReactNode[] {
  const usage = props.usage;
  const pending = props.networkRequests.filter((request) => request.status === "pending").length;
  const failed = props.networkRequests.filter((request) => request.status === "error").length;
  const lines = [
    rowLine(
      props.copy.sidebar.api.model,
      usage ? String(usage.modelRequestCount) : "-",
      "api-model",
    ),
    rowLine(
      props.copy.sidebar.api.server,
      usage ? `fetch ${usage.webFetchRequests} / search ${usage.webSearchRequests}` : "-",
      "api-server",
    ),
    rowLine(
      props.copy.sidebar.api.requests,
      props.networkRequests.length > 0
        ? `${pending} pending / ${failed} error / ${props.networkRequests.length} recent`
        : "-",
      "api-requests",
    ),
  ];

  if (props.networkRequests.length === 0) {
    lines.push(textLine(props.copy.sidebar.api.empty, palette.muted, "api-empty"));
    return lines;
  }

  for (const request of props.networkRequests.slice(0, 5)) {
    lines.push(
      textLine(formatRequestLine(request, props.copy), requestColor(request), `api-${request.id}`),
    );
  }
  if (props.networkRequests.length > 5) {
    lines.push(
      textLine(
        props.copy.sidebar.api.more(props.networkRequests.length - 5),
        palette.muted,
        "api-more",
      ),
    );
  }
  return lines;
}

function rowLine(label: string, value: string, key: string): React.ReactElement {
  return textLine(
    `${padEndDisplay(label, SIDEBAR_LABEL_WIDTH)} ${truncateDisplay(value, SIDEBAR_ROW_VALUE_WIDTH)}`,
    palette.text,
    key,
  );
}

function textLine(value: string, color: string, key: string): React.ReactElement {
  return h("text", { key, style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: color } }, value);
}

function padEndDisplay(value: string, targetCells: number): string {
  const visible = truncateDisplay(value, targetCells);
  return `${visible}${" ".repeat(Math.max(0, targetCells - displayWidth(visible)))}`;
}

function formatRequestLine(request: NetworkRequest, copy: TuiCopy): string {
  const status = requestStatusLabel(request, copy);
  const method = request.method.toUpperCase();
  const target = requestTargetLabel(request);
  const duration = request.durationMs === undefined ? "" : ` ${formatDuration(request.durationMs)}`;
  const prefix = `${status} ${method} `;
  if (!duration) return truncateDisplay(`${prefix}${target}`, SIDEBAR_CONTENT_WIDTH);

  const urlWidth = SIDEBAR_CONTENT_WIDTH - prefix.length - duration.length;
  if (urlWidth <= 0) {
    return truncateDisplay(`${prefix}${target}${duration}`, SIDEBAR_CONTENT_WIDTH);
  }
  return `${prefix}${truncateDisplay(target, urlWidth)}${duration}`;
}

function requestTargetLabel(request: NetworkRequest): string {
  if (!request.provider) return request.url;

  const providerLabel = requestProviderLabel(request.provider);
  if (request.url.startsWith(`${request.provider} `)) {
    return `${providerLabel}${request.url.slice(request.provider.length)}`;
  }
  if (request.url === request.provider) return providerLabel;
  if (request.url === `${request.provider}/${request.model}`) {
    return `${providerLabel}/${request.model}`;
  }
  return `${providerLabel} ${request.url}`;
}

function requestProviderLabel(provider: string): string {
  if (!UUID_IDENTIFIER_PATTERN.test(provider)) return provider;
  return `${provider.slice(0, COMPACT_IDENTIFIER_PREFIX_LENGTH)}...${provider.slice(
    -COMPACT_IDENTIFIER_SUFFIX_LENGTH,
  )}`;
}

function requestColor(request: NetworkRequest): string {
  if (request.status === "error") return palette.danger;
  if (request.status === "pending") return palette.accent;
  return palette.muted;
}

function requestStatusLabel(request: NetworkRequest, copy: TuiCopy): string {
  if (request.status === "pending") return copy.sidebar.request.pending;
  if (request.status === "error") {
    return request.statusCode === undefined
      ? copy.sidebar.request.error
      : copy.sidebar.request.errorWithStatus(request.statusCode);
  }
  return copy.sidebar.request.complete;
}
