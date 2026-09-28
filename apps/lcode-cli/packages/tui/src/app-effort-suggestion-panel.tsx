import React from "react";
import { visibleEffortOptionWindow } from "./app-input.js";
import { palette } from "./app-model.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import type { TuiEffortOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const EFFORT_OPTION_VISIBLE_COUNT = 6;
const EFFORT_OPTION_PANEL_CHROME_ROWS = 2;
const EFFORT_OPTION_ROW_HEIGHT = 1;
const EFFORT_ROW_SELECTOR_WIDTH = 2;
const EFFORT_ROW_DETAIL_GAP_WIDTH = 2;
const EFFORT_ROW_MIN_CONTENT_WIDTH = 12;
const EFFORT_ROW_MIN_LABEL_WIDTH = 4;
const EFFORT_ROW_FALLBACK_CONTENT_WIDTH = 80;
const EFFORT_ROW_MAX_DETAIL_RATIO = 0.65;

type FittedEffortOptionRow = {
  detail: string;
  detailWidth: number;
  label: string;
};

export function EffortSuggestionPanel({
  contentWidth,
  currentEffort,
  efforts,
  selectedIndex,
}: {
  contentWidth?: number;
  currentEffort: string;
  efforts: readonly TuiEffortOption[];
  selectedIndex: number;
}): React.ReactElement | null {
  const visible = visibleEffortOptionWindow(efforts, selectedIndex, EFFORT_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeEffortRowContentWidth(contentWidth);
  const rows =
    visible.efforts.length > 0
      ? visible.efforts.map((effort, index) => ({
          effort,
          fitted: fitEffortOptionRow(
            {
              detail: effortDetail(effort, effort.id === currentEffort),
              label: effort.label,
            },
            rowContentWidth,
          ),
          selected: index === visible.selectedIndex,
        }))
      : [];
  const panelHeight =
    EFFORT_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * EFFORT_OPTION_ROW_HEIGHT;

  return h(
    "box",
    {
      title: "Effort",
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    rows.length > 0
      ? rows.map((row) =>
          h(EffortSuggestionRow, {
            key: row.effort.id,
            fitted: row.fitted,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: EFFORT_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching efforts.",
        ),
  );
}

function EffortSuggestionRow({
  fitted,
  selected,
}: {
  fitted: FittedEffortOptionRow;
  selected: boolean;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: EFFORT_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: EFFORT_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.text,
          flexShrink: 0,
          width: displayWidth(fitted.label),
        },
      },
      fitted.label,
    ),
    fitted.detail
      ? h("box", {
          style: {
            flexGrow: 1,
            minWidth: EFFORT_ROW_DETAIL_GAP_WIDTH,
          },
        })
      : null,
    fitted.detail
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
              width: fitted.detailWidth,
            },
          },
          fitted.detail,
        )
      : null,
  );
}

function effortDetail(effort: TuiEffortOption, current: boolean): string {
  const description = effort.description?.trim();
  const alias = effort.label !== effort.id ? effort.id : "";
  return [description, alias, current ? "current" : ""].filter(Boolean).join("  ");
}

function fitEffortOptionRow(
  parts: { detail: string; label: string },
  contentWidth: number,
): FittedEffortOptionRow {
  const detailBudget = detailColumnBudget(parts.detail, contentWidth);
  const detail = truncateDisplay(parts.detail, detailBudget);
  const detailWidth = displayWidth(detail);
  const detailGapWidth = detail ? EFFORT_ROW_DETAIL_GAP_WIDTH : 0;
  const labelBudget = Math.max(
    1,
    contentWidth - EFFORT_ROW_SELECTOR_WIDTH - detailGapWidth - detailWidth,
  );

  return {
    detail,
    detailWidth,
    label: truncateDisplay(parts.label, labelBudget),
  };
}

function detailColumnBudget(detail: string, contentWidth: number): number {
  if (!detail) return 0;
  const detailMax = Math.floor(contentWidth * EFFORT_ROW_MAX_DETAIL_RATIO);
  const detailBudget =
    contentWidth -
    EFFORT_ROW_SELECTOR_WIDTH -
    EFFORT_ROW_DETAIL_GAP_WIDTH -
    EFFORT_ROW_MIN_LABEL_WIDTH;
  return Math.max(0, Math.min(detailMax, detailBudget));
}

function normalizeEffortRowContentWidth(contentWidth: number | undefined): number {
  if (!contentWidth || !Number.isFinite(contentWidth)) return EFFORT_ROW_FALLBACK_CONTENT_WIDTH;
  return Math.max(EFFORT_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
