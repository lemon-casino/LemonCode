import type { TuiCopy } from "@lcode/i18n";
import React from "react";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import type { QueuedInput } from "./app-model.js";
import { palette } from "./app-model.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const QUEUED_INPUT_VISIBLE_COUNT = 3;
const QUEUED_INPUT_PANEL_CHROME_ROWS = 2;
const QUEUED_INPUT_HINT_ROWS = 1;
const QUEUED_INPUT_ROW_HEIGHT = 1;
const QUEUED_INPUT_INDEX_WIDTH = 4;
const QUEUED_INPUT_FALLBACK_CONTENT_WIDTH = 80;
const QUEUED_INPUT_MIN_CONTENT_WIDTH = 12;

export function QueuedInputPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  inputs,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  inputs: QueuedInput[];
}): React.ReactElement | null {
  if (inputs.length === 0) return null;

  const visible = inputs.slice(0, QUEUED_INPUT_VISIBLE_COUNT);
  const hiddenCount = Math.max(0, inputs.length - visible.length);
  const rowContentWidth = normalizeQueuedInputContentWidth(contentWidth);

  return h(
    "box",
    {
      title: copy.input.queuedTitle(inputs.length),
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: queuedInputPanelHeight(inputs.length),
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    h("text", { key: "hint", style: { fg: palette.muted } }, copy.input.queuedSubmitHint),
    ...visible.map((input, index) =>
      h(QueuedInputRow, {
        contentWidth: rowContentWidth,
        input,
        key: input.id,
        position: index + 1,
      }),
    ),
    hiddenCount > 0
      ? h("text", { key: "more", style: { fg: palette.muted } }, copy.input.queuedMore(hiddenCount))
      : null,
  );
}

export function upsertQueuedInput(
  current: QueuedInput[],
  input: QueuedInput,
  options: { preserveExistingText?: boolean } = {},
): QueuedInput[] {
  const existingIndex = current.findIndex((item) => item.id === input.id);
  if (existingIndex === -1) return [...current, input];

  const existing = current[existingIndex]!;
  const nextInput = {
    ...existing,
    ...input,
    text: options.preserveExistingText && existing.text ? existing.text : input.text,
  };
  if (existing.id === nextInput.id && existing.text === nextInput.text) return current;

  return [
    ...current.slice(0, existingIndex),
    nextInput,
    ...current.slice(existingIndex + 1),
  ];
}

export function removeQueuedInputs(current: QueuedInput[], ids: readonly string[]): QueuedInput[] {
  if (ids.length === 0) return current;
  const idsToRemove = new Set(ids);
  return current.filter((input) => !idsToRemove.has(input.id));
}

function queuedInputPanelHeight(inputCount: number): number {
  const visibleCount = Math.min(Math.max(0, inputCount), QUEUED_INPUT_VISIBLE_COUNT);
  const hiddenRows = inputCount > visibleCount ? 1 : 0;
  return (
    QUEUED_INPUT_PANEL_CHROME_ROWS +
    QUEUED_INPUT_HINT_ROWS +
    visibleCount * QUEUED_INPUT_ROW_HEIGHT +
    hiddenRows
  );
}

function QueuedInputRow({
  contentWidth,
  input,
  position,
}: {
  contentWidth: number;
  input: QueuedInput;
  position: number;
}): React.ReactElement {
  const indexLabel = `${position}.`;
  const textWidth = Math.max(
    QUEUED_INPUT_MIN_CONTENT_WIDTH,
    contentWidth - QUEUED_INPUT_INDEX_WIDTH,
  );

  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: QUEUED_INPUT_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: palette.accent,
          flexShrink: 0,
          width: QUEUED_INPUT_INDEX_WIDTH,
        },
      },
      indexLabel.padEnd(QUEUED_INPUT_INDEX_WIDTH),
    ),
    h(
      "text",
      {
        style: {
          fg: palette.text,
          flexShrink: 1,
          minWidth: 1,
          width: displayWidth(truncateDisplay(input.text, textWidth)),
        },
      },
      truncateDisplay(input.text, textWidth),
    ),
  );
}

function normalizeQueuedInputContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return QUEUED_INPUT_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(QUEUED_INPUT_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
