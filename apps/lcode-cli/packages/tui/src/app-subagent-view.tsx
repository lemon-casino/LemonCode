import React from "react";
import type { TuiCopy } from "@lcode/i18n";
import { ContentPane } from "./app-transcript-components.js";
import { palette } from "./app-model.js";
import { truncateDisplay } from "./app-terminal-width.js";
import type { SubagentsController } from "./app-subagents.js";

const h = React.createElement;

export function SubagentView({
  controller,
  copy,
  contentWidth,
  pendingMain,
}: {
  controller: SubagentsController;
  copy: TuiCopy;
  contentWidth: number;
  pendingMain: boolean;
}): React.ReactElement {
  const labels = copy.sidebar.subagents;
  const selected = controller.selected!;
  const transcript = controller.transcript;
  const messages = transcript?.liveModelText
    ? [
        ...transcript.messages,
        { role: "agent" as const, content: transcript.liveModelText, streaming: true },
      ]
    : (transcript?.messages ?? []);
  const clickBack = (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    controller.back();
  };
  return h(
    "box",
    { id: "subagent-view", style: { flexDirection: "column", flexGrow: 1, minHeight: 0 } },
    h(
      "text",
      {
        id: "subagent-back",
        selectable: false,
        onMouseUp: clickBack,
        style: { fg: palette.accent, height: 1, flexShrink: 0 },
      },
      labels.back,
    ),
    h(
      "text",
      { style: { fg: palette.text, height: 1, flexShrink: 0 } },
      truncateDisplay(`${selected.title} · ${labels.status[selected.status]}`, contentWidth),
    ),
    h("text", { style: { fg: palette.muted, height: 1, flexShrink: 0 } }, labels.readonly),
    pendingMain
      ? h(
          "text",
          {
            selectable: false,
            onMouseUp: clickBack,
            style: { fg: palette.warning, flexShrink: 0 },
          },
          labels.pendingMain,
        )
      : null,
    controller.loading
      ? h("text", { style: { fg: palette.muted } }, labels.loading)
      : controller.error
        ? h(
            "box",
            { style: { flexDirection: "column" } },
            h(
              "text",
              { style: { fg: palette.danger } },
              `${labels.unavailable} ${controller.error}`,
            ),
            h(
              "text",
              {
                selectable: false,
                onMouseUp: (event: { stopPropagation(): void }) => {
                  event.stopPropagation();
                  controller.open(selected);
                },
                style: { fg: palette.accent },
              },
              labels.retry,
            ),
          )
        : h(ContentPane, {
            key: selected.childSessionId,
            copy,
            focused: true,
            messages,
            terminalWidth: contentWidth,
            emptyText: labels.emptyOutput,
          }),
  );
}
