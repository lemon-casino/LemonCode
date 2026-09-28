import React from "react";
import { useTerminalDimensions } from "@mbears/opentui-react";
import type { TuiCopy } from "@lcode/i18n";
import { palette } from "./app-model.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { truncateDisplay } from "./app-terminal-width.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";

const h = React.createElement;
type ClickEvent = { stopPropagation(): void };

export function SubagentsSection({
  controller,
  copy,
  expanded,
  onToggle,
  onOpen,
}: {
  controller: SubagentsController;
  copy: TuiCopy;
  expanded: boolean;
  onToggle(): void;
  onOpen(item: SubagentItem): void;
}): React.ReactElement {
  const [endedOpen, setEndedOpen] = React.useState(false);
  const { height } = useTerminalDimensions();
  const { directory, selected } = controller;
  const labels = copy.sidebar.subagents;
  const items = [...directory.running, ...(endedOpen ? directory.ended.items : [])];
  const contentHeight =
    items.length * 2 +
    (directory.ended.total ? 1 : 0) +
    (endedOpen && directory.ended.nextCursor ? 1 : 0);
  return h(
    "box",
    { style: { flexDirection: "column", flexShrink: 0, marginTop: 1 } },
    h(SidebarSectionHeader, {
      title: `${labels.title} (${directory.running.length})`,
      expanded,
      onToggle,
    }),
    expanded
      ? h(
          "scrollbox",
          {
            id: "subagent-directory",
            scrollX: false,
            style: {
              height: Math.max(1, Math.min(contentHeight || 1, Math.max(3, height - 22))),
              contentOptions: { flexDirection: "column" },
            },
          },
          ...items.map((item) =>
            h(
              "box",
              {
                key: item.childSessionId,
                id: `subagent-${item.childSessionId}`,
                onMouseUp: (event: ClickEvent) => {
                  event.stopPropagation();
                  onOpen(item);
                },
                style: {
                  flexDirection: "column",
                  height: 2,
                  flexShrink: 0,
                  backgroundColor:
                    selected?.childSessionId === item.childSessionId
                      ? palette.panel
                      : palette.panelAlt,
                },
              },
              h(
                "text",
                {
                  selectable: false,
                  style: {
                    fg:
                      selected?.childSessionId === item.childSessionId
                        ? palette.accent
                        : palette.text,
                    height: 1,
                    wrapMode: "none",
                  },
                },
                truncateDisplay(
                  `${selected?.childSessionId === item.childSessionId ? "›" : "·"} ${item.title}`,
                  SIDEBAR_CONTENT_WIDTH - 1,
                ),
              ),
              h(
                "text",
                {
                  selectable: false,
                  style: {
                    fg: item.status === "failed" ? palette.danger : palette.muted,
                    height: 1,
                    wrapMode: "none",
                  },
                },
                truncateDisplay(
                  `  ${item.subagentType} · ${labels.status[item.status]}`,
                  SIDEBAR_CONTENT_WIDTH - 1,
                ),
              ),
            ),
          ),
          directory.ended.total
            ? h(
                "text",
                {
                  selectable: false,
                  onMouseUp: (event: ClickEvent) => {
                    event.stopPropagation();
                    setEndedOpen((value) => !value);
                  },
                  style: { fg: palette.muted, height: 1 },
                },
                `${endedOpen ? "▼" : "▶"} ${labels.ended(directory.ended.total)}`,
              )
            : null,
          endedOpen && directory.ended.nextCursor
            ? h(
                "text",
                {
                  selectable: false,
                  onMouseUp: (event: ClickEvent) => {
                    event.stopPropagation();
                    void controller.loadMore();
                  },
                  style: { fg: palette.accent, height: 1 },
                },
                labels.more,
              )
            : null,
          contentHeight === 0
            ? h(
                "text",
                { style: { fg: palette.muted, height: 1 } },
                controller.directoryError ? labels.unavailable : labels.empty,
              )
            : null,
        )
      : null,
  );
}
