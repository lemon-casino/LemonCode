import { TextAttributes } from "@mbears/opentui-core";
import React from "react";
import { palette } from "./app-model.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const EXPANDED_MARKER = "▼";
const COLLAPSED_MARKER = "▶";
const SIDEBAR_SECTION_HEADER_STYLE = {
  attributes: TextAttributes.BOLD,
  fg: palette.text,
  flexShrink: 0,
  height: 1,
  truncate: true,
  width: SIDEBAR_CONTENT_WIDTH,
  wrapMode: "none",
};

type MouseEventLike = {
  stopPropagation?: () => void;
};

export function SidebarSectionHeader(props: {
  expanded: boolean;
  onToggle?: () => void;
  title: string;
}): React.ReactElement {
  const marker = props.expanded ? EXPANDED_MARKER : COLLAPSED_MARKER;
  return h(
    "text",
    {
      onMouseUp: (event: MouseEventLike) => {
        event.stopPropagation?.();
        props.onToggle?.();
      },
      selectable: false,
      style: SIDEBAR_SECTION_HEADER_STYLE,
    },
    `${marker} ${props.title}`,
  );
}
