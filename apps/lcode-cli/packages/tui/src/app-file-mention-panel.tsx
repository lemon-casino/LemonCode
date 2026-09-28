import type { TuiCopy } from "@lcode/i18n";
import React from "react";
import {
  FILE_MENTION_VISIBLE_COUNT,
  type FileMentionState,
  visibleFileMentionWindow,
} from "./app-file-mentions.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { wordWrappedLineCount } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const FILE_MENTION_PANEL_CHROME_ROWS = 2;
const FILE_MENTION_FALLBACK_CONTENT_WIDTH = 80;
const MIN_FILE_MENTION_CONTENT_WIDTH = 8;

export function FileMentionPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  state,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  state: FileMentionState;
}): React.ReactElement | null {
  const rowContentWidth = normalizeFileMentionContentWidth(contentWidth);
  const visible = visibleFileMentionWindow(
    state.items,
    state.selectedIndex,
    FILE_MENTION_VISIBLE_COUNT,
  );
  const rows =
    visible.items.length > 0
      ? visible.items.map((item, index) => {
          const text = copy.fileMention.row({
            path: item.path,
            selected: index === visible.selectedIndex,
          });
          return {
            item,
            selected: index === visible.selectedIndex,
            text,
            height: wordWrappedLineCount(text, rowContentWidth),
          };
        })
      : [
          {
            item: undefined,
            selected: false,
            text: state.loading ? copy.fileMention.loading : copy.fileMention.empty,
            height: 1,
          },
        ];
  const panelHeight =
    FILE_MENTION_PANEL_CHROME_ROWS + rows.reduce((height, row) => height + row.height, 0);

  return h(
    "box",
    {
      title: copy.fileMention.title,
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
    ...rows.map((row, index) =>
      h(
        "text",
        {
          key: row.item?.path ?? `file-mention-${index}`,
          style: {
            fg: row.selected ? palette.accent : row.item ? palette.text : palette.warning,
            height: row.height,
            width: "100%",
            wrapMode: "word",
          },
        },
        row.text,
      ),
    ),
  );
}

function normalizeFileMentionContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return FILE_MENTION_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MIN_FILE_MENTION_CONTENT_WIDTH, Math.floor(contentWidth));
}
