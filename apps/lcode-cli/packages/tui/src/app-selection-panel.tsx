import React from "react";
import type { TuiCopy } from "@lcode/i18n";
import type { SelectionState } from "./app-model.js";
import { palette } from "./app-model.js";
import {
  filterSelectionItems,
  selectionInputDisplayValue,
  visibleSelectionItemWindow,
} from "./app-selection-keyboard.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const PANEL_CHROME_ROWS = 4;
const CHOICE_PANEL_HEIGHT = PANEL_CHROME_ROWS + 7;
const SELECTION_VISIBLE_COUNT = 5;
const SELECTION_ROW_HEIGHT = 1;
const SELECTION_ROW_SELECTOR_WIDTH = 2;
const SELECTION_ROW_DETAIL_GAP_WIDTH = 2;
const SELECTION_ROW_MIN_CONTENT_WIDTH = 12;
const SELECTION_ROW_MIN_PRIMARY_WIDTH = 8;
const SELECTION_ROW_FALLBACK_CONTENT_WIDTH = 80;
const SELECTION_ROW_MAX_DETAIL_RATIO = 0.55;

type FittedSelectionRow = {
  detail: string;
  detailWidth: number;
  primary: string;
};

export function SelectionPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  selection,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  selection: SelectionState;
}): React.ReactElement {
  const visible = filterSelectionItems(selection);
  const visibleWindow = visibleSelectionItemWindow(
    visible,
    selection.selectedIndex,
    SELECTION_VISIBLE_COUNT,
  );
  const rowContentWidth = normalizeSelectionContentWidth(contentWidth);

  return h(
    "box",
    {
      title: selection.title,
      style: panelStyle({ borderColor: palette.accent, height: CHOICE_PANEL_HEIGHT }),
    },
    ...(selection.input
      ? inputSelectionContent(selection.input, rowContentWidth)
      : selection.pending
        ? pendingSelectionContent(selection.pending)
        : selectionContent(selection, copy, visibleWindow, rowContentWidth)),
  );
}

function inputSelectionContent(
  input: NonNullable<SelectionState["input"]>,
  rowContentWidth: number,
): React.ReactNode[] {
  const value = selectionInputDisplayValue(input);
  const inputLine = `> ${value}`;
  const inputColor = input.value ? palette.text : palette.muted;
  return [
    h("text", { key: "primary", style: { fg: palette.accent } }, input.primary),
    input.secondary
      ? h("text", { key: "secondary", style: { fg: palette.muted, wrapMode: "word" } }, input.secondary)
      : null,
    h(
      "text",
      { key: "input", style: { fg: inputColor } },
      truncateDisplay(inputLine, rowContentWidth),
    ),
    input.help
      ? h("text", { key: "help", style: { fg: palette.muted, wrapMode: "word" } }, input.help)
      : null,
  ].filter((child): child is React.ReactElement => Boolean(child));
}

function pendingSelectionContent(
  pending: NonNullable<SelectionState["pending"]>,
): React.ReactNode[] {
  return [
    h("text", { key: "primary", style: { fg: palette.accent } }, pending.primary),
    pending.secondary
      ? h("text", { key: "secondary", style: { fg: palette.muted, wrapMode: "word" } }, pending.secondary)
      : null,
    pending.help
      ? h("text", { key: "help", style: { fg: palette.muted, wrapMode: "word" } }, pending.help)
      : null,
  ].filter((child): child is React.ReactElement => Boolean(child));
}

function selectionContent(
  selection: SelectionState,
  copy: TuiCopy,
  visibleWindow: ReturnType<typeof visibleSelectionItemWindow>,
  rowContentWidth: number,
): React.ReactNode[] {
  return [
    h("text", { style: { fg: palette.text } }, selection.prompt),
    h("text", { style: { fg: palette.muted } }, selectionHelperText(selection, copy)),
    ...(visibleWindow.items.length === 0
      ? [h("text", { key: "empty", style: { fg: palette.warning } }, selection.emptyMessage)]
      : visibleWindow.items.map((item, index) =>
          h(SelectionRow, {
            fitted: fitSelectionRow(
              {
                detail: selectionRowDetail(item, copy),
                primary: item.primary,
              },
              rowContentWidth,
            ),
            itemDisabled: Boolean(item.disabledReason),
            key: item.id,
            selected: index === visibleWindow.selectedIndex,
          }),
        )),
  ];
}

function SelectionRow({
  fitted,
  itemDisabled,
  selected,
}: {
  fitted: FittedSelectionRow;
  itemDisabled: boolean;
  selected: boolean;
}): React.ReactElement {
  const primaryColor = selected ? palette.accent : itemDisabled ? palette.muted : palette.text;

  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: SELECTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: SELECTION_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: primaryColor,
          flexShrink: 0,
          width: displayWidth(fitted.primary),
        },
      },
      fitted.primary,
    ),
    fitted.detail
      ? h("box", {
          style: {
            flexGrow: 1,
            minWidth: SELECTION_ROW_DETAIL_GAP_WIDTH,
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

function selectionHelperText(selection: SelectionState, copy: TuiCopy): string {
  if (selection.filterable === false) return selection.help ?? copy.selection.defaultHelp;
  return copy.selection.filterLine({
    filter: selection.filter || copy.selection.noFilter,
    help: selection.help,
  });
}

function selectionRowDetail(
  item: SelectionState["items"][number],
  copy: TuiCopy,
): string {
  return [
    item.secondary,
    item.meta ? `(${item.meta})` : undefined,
    item.disabledReason ? copy.selection.disabled(item.disabledReason).trim() : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("  ");
}

function fitSelectionRow(
  parts: { detail: string; primary: string },
  contentWidth: number,
): FittedSelectionRow {
  const detailBudget = detailColumnBudget(parts.detail, contentWidth);
  const detail = truncateDisplay(parts.detail, detailBudget);
  const detailWidth = displayWidth(detail);
  const detailGapWidth = detail ? SELECTION_ROW_DETAIL_GAP_WIDTH : 0;
  const primaryBudget = Math.max(
    1,
    contentWidth - SELECTION_ROW_SELECTOR_WIDTH - detailGapWidth - detailWidth,
  );

  return {
    detail,
    detailWidth,
    primary: truncateDisplay(parts.primary, primaryBudget),
  };
}

function detailColumnBudget(detail: string, contentWidth: number): number {
  if (!detail) return 0;
  const detailMax = Math.floor(contentWidth * SELECTION_ROW_MAX_DETAIL_RATIO);
  const detailBudget =
    contentWidth -
    SELECTION_ROW_SELECTOR_WIDTH -
    SELECTION_ROW_DETAIL_GAP_WIDTH -
    SELECTION_ROW_MIN_PRIMARY_WIDTH;
  return Math.max(0, Math.min(detailMax, detailBudget));
}

function normalizeSelectionContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return SELECTION_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(SELECTION_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

function panelStyle({
  borderColor,
  height,
}: {
  borderColor: string;
  height: number;
}): Record<string, unknown> {
  return {
    backgroundColor: palette.panel,
    border: true,
    borderColor,
    flexDirection: "column",
    height,
    marginBottom: 1,
    padding: 1,
    width: "100%",
  };
}
