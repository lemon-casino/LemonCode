import { getLCodeCopy } from "@lcode/i18n";
import type { CommandCenterApp } from "./command-center.js";

export function loginRequiredResponse(locale?: string): string {
  const copy = getLCodeCopy(locale).tui.loginRequired;
  return [copy.message, copy.help].join("\n");
}

/** Registry already applies provider/account availability, including personal providers. */
export function createTuiModelAvailabilityChecker(
  getApp: () => Promise<CommandCenterApp>,
): () => Promise<boolean> {
  return async () => {
    const app = await getApp();
    return ((await app.listModels?.()) ?? []).some((model) => !model.disabledReason);
  };
}
