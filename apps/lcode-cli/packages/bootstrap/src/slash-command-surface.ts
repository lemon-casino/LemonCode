import { BUILTIN_LCODE_SLASH_COMMAND_HELP_ENTRIES, type LCodeSlashCommand } from "@lcode/shared";

export const APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = [
  "goal",
  "compact",
  "init",
] as const;

/** 仅供 App Composer 使用的命令，不扩展 CLI TUI/help surface。 */
export const APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS = [
  {
    description: "Switch to Plan mode and optionally send a task.",
    inputHint: "/plan [task]",
    name: "plan",
    source: "builtin",
  },
] as const satisfies readonly LCodeSlashCommand[];

const EXTRA_RESERVED_SLASH_COMMAND_NAMES = ["compress", "plan"] as const;

const RESERVED_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_LCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat([...EXTRA_RESERVED_SLASH_COMMAND_NAMES]),
);

function normalizeLCodeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isReservedLCodeSlashCommandName(name: string): boolean {
  return RESERVED_SLASH_COMMAND_NAMES.has(normalizeLCodeSlashCommandName(name));
}
