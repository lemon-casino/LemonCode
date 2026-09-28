import { useKeyboard } from "@mbears/opentui-react";
import { getLCodeCopy } from "@lcode/i18n";
import React from "react";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import { palette } from "./app-model.js";
import type { TuiOptions } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function TuiStartupScreen({
  options,
  onExit,
}: {
  options: TuiOptions;
  onExit: (code: number) => void;
}): React.ReactElement {
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") onExit(130);
  });
  return h(
    "box",
    { style: { flexDirection: "column", width: "100%", height: "100%", padding: 1 } },
    h(EmptyTranscriptLogo),
    h("text", { style: { fg: palette.muted } }, options.workspaceDirectory),
    h("text", { style: { fg: palette.text } }, getLCodeCopy(options.locale).tui.terminal.starting),
  );
}
