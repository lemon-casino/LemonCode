import React from "react";
import type { ToolResultDisplayLine, ToolTranscriptPart } from "./app-model.js";
import { ShikiDiffView, diffViewForWidth } from "./app-shiki-diff-view.js";
import { palette } from "./app-model.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { activeTuiTheme } from "./theme/index.js";

const MAX_OUTPUT_LINES = 8;
const OUTPUT_LINE_INDENT_WIDTH = 4;
const TOOL_DETAIL_INDENT = "  ";
const TOOL_OUTPUT_LINE_INDENT = "    ";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function ToolTranscriptPartView({
  part,
  terminalWidth = 100,
}: {
  part: ToolTranscriptPart;
  terminalWidth?: number;
}): React.ReactElement {
  const statusColor = colorForStatus(part.status);
  const title = part.title ?? `Tool ${part.toolName} ${part.status}`;
  const outputLines = part.output ? restoredOutputLines(part.output, terminalWidth) : [];
  // tool rows should align with assistant text; child detail rows carry their own indent.
  return h(
    "box",
    {
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginTop: 1,
        width: "100%",
      },
    },
    h("text", { style: { fg: part.title ? palette.muted : statusColor } }, title),
    ...part.detailLines.map((line, index) =>
      h(
        "text",
        { key: `detail-${index}`, style: { fg: palette.muted } },
        `${TOOL_DETAIL_INDENT}${line}`,
      ),
    ),
    ...(part.resultDisplay
      ? [
          ...(part.resultDisplay.title
            ? [
                h(
                  "text",
                  { key: "result-title", style: { fg: palette.muted } },
                  `${TOOL_DETAIL_INDENT}${part.resultDisplay.title}`,
                ),
              ]
            : []),
          ...resultDisplayNodes(part.resultDisplay, terminalWidth),
        ]
      : []),
    ...(outputLines.length > 0
      ? [
          h(
            "text",
            { key: "output-title", style: { fg: palette.muted } },
            `${TOOL_DETAIL_INDENT}output:`,
          ),
          ...outputLines.map((line, index) =>
            h(
              "text",
              { key: `output-${index}`, style: { fg: palette.muted } },
              `${TOOL_OUTPUT_LINE_INDENT}${line}`,
            ),
          ),
        ]
      : []),
    ...(part.error ? [h("text", { key: "error", style: { fg: palette.danger } }, part.error)] : []),
  );
}

function resultDisplayNodes(
  display: NonNullable<ToolTranscriptPart["resultDisplay"]>,
  terminalWidth: number,
): React.ReactElement[] {
  if (display.structuredPatch?.length) {
    return [
      h(ShikiDiffView, {
        filePath: display.filePath,
        key: "result-shiki-diff",
        structuredPatch: display.structuredPatch,
        terminalWidth,
        truncated: display.truncated,
        view: diffViewForWidth(terminalWidth),
      }),
    ];
  }
  return display.lines.map((line, index) =>
    h(
      "text",
      { key: `result-${index}`, style: styleForDiffLine(line) },
      `${TOOL_DETAIL_INDENT}${line.text}`,
    ),
  );
}

function colorForStatus(status: ToolTranscriptPart["status"]): string {
  if (status === "completed") return palette.success;
  if (status === "failed") return palette.danger;
  if (status === "running") return palette.accent;
  return palette.warning;
}

function styleForDiffLine(line: ToolResultDisplayLine): Record<string, string> {
  const theme = activeTuiTheme();
  if (line.tone === "addition") {
    return { bg: theme.diffAddedBg, fg: theme.diffAdded };
  }
  if (line.tone === "deletion") {
    return { bg: theme.diffRemovedBg, fg: theme.diffRemoved };
  }
  return { fg: line.tone === "meta" ? theme.diffLineNumber : theme.diffContext };
}

function restoredOutputLines(output: string, terminalWidth: number): string[] {
  const width = Math.max(20, terminalWidth - OUTPUT_LINE_INDENT_WIDTH);
  const lines = output.split(/\r?\n/u);
  const visible = lines.slice(0, MAX_OUTPUT_LINES).map((line) => truncateDisplay(line, width));
  if (lines.length > MAX_OUTPUT_LINES) {
    visible.push(`[truncated ${lines.length - MAX_OUTPUT_LINES} lines]`);
  }
  return visible.filter((line) => line.trim().length > 0);
}
