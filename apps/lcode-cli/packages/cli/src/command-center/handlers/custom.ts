import type { TuiSubmitPromptResult } from "@lcode/tui";
import { buildCustomCommandPrompt } from "../../command-center-custom.js";
import { attachCurrentSessionMetadata } from "../metadata.js";
import type { CommandCenterDeps, TuiSubmitOptions } from "../types.js";

export async function handleCustomCommand(
  name: string,
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult | undefined> {
  const prompt = await buildCustomCommandPrompt(name, args, deps);
  if (!prompt) return undefined;
  const app = await deps.getApp();
  const result = await app.submitPrompt(prompt, options);
  return attachCurrentSessionMetadata(result, deps, app);
}
