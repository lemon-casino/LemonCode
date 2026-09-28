import { isSedInPlaceBashCommand } from "./bash-semantics.js";

export function getBashDescription(input: unknown): string {
  const description = readStringProperty(input, "description");
  return description && description.length > 0 ? description : "Run shell command";
}

export function getBashUserFacingName(input?: unknown): string {
  const command = readStringProperty(input, "command");
  if (command && isSedInPlaceBashCommand(command)) return "Update";
  return "Bash";
}

export function getBashToolUseSummary(input?: unknown): string | null {
  const command = readStringProperty(input, "command");
  if (!command) return null;
  const description = readStringProperty(input, "description");
  return description && description.length > 0 ? description : command;
}

export function getBashActivityDescription(input?: unknown): string {
  const command = readStringProperty(input, "command");
  if (!command) return "Running command";
  const description = readStringProperty(input, "description");
  return `Running ${description && description.length > 0 ? description : command}`;
}

export function getBashAutoClassifierInput(input: unknown): string | undefined {
  return readStringProperty(input, "command");
}

export function readStringProperty(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
