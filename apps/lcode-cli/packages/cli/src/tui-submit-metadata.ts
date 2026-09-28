import type { TuiSubmitPromptResult } from "@lcode/tui";
import type { CommandCenterMode, CommandCenterApp } from "./command-center.js";

export function withTuiMetadata(
  result: TuiSubmitPromptResult,
  activeApp: CommandCenterApp,
  mode: CommandCenterMode,
): { kind: "started_turn"; result: TuiSubmitPromptResult } {
  return {
    kind: "started_turn",
    result: {
      ...result,
      locale: result.locale ?? activeApp.getLocale?.(),
      mode,
      model: result.model ?? activeApp.getModel?.(),
      theme: result.theme ?? activeApp.getTheme?.(),
      thoughtLevel: result.thoughtLevel ?? activeApp.getThoughtLevel?.(),
    },
  };
}
