import type { TuiPromptInput, TuiSubmitPromptResult } from "@lcode/tui";
import type { CommandCenterApp, CommandCenterDeps } from "./types.js";

export function normalizeTuiPromptInput(input: TuiPromptInput): Exclude<TuiPromptInput, string> {
  if (typeof input === "string") return { text: input };
  return input;
}

export function attachCurrentSessionMetadata(
  result: TuiSubmitPromptResult,
  deps: CommandCenterDeps,
  app?: CommandCenterApp,
): TuiSubmitPromptResult {
  return {
    ...result,
    locale: result.locale ?? app?.getLocale?.(),
    mode: result.mode ?? deps.getMode?.(),
    model: result.model ?? app?.getModel?.(),
    theme: result.theme ?? app?.getTheme?.(),
    thoughtLevel: result.thoughtLevel ?? app?.getThoughtLevel?.(),
  };
}
