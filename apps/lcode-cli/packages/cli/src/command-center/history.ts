import type { TuiPromptInput } from "@lcode/tui";
import type { SlashCommand } from "./slash-command-types.js";
import type { CommandCenterDeps } from "./types.js";

const API_KEY_LOGIN_PATTERN = /(?:^|\s)(?:bigmodel|zai)-coding-plan-api-key(?:\s|$)/u;

export async function recordSlashCommandInHistory(
  deps: CommandCenterDeps,
  input: TuiPromptInput,
  command: SlashCommand,
): Promise<void> {
  if (!deps.recordInputHistory || !shouldRecordSlashCommand(command)) return;
  try {
    await deps.recordInputHistory(input, "slash_command");
  } catch {
    // Input history is recall UX; command execution must not depend on it.
  }
}

function shouldRecordSlashCommand(command: SlashCommand): boolean {
  if (command.type !== "known") return true;
  if (command.name !== "login") return true;
  return !API_KEY_LOGIN_PATTERN.test(command.args);
}
