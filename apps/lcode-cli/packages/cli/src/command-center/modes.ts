import type { SwitchableCommandCenterMode } from "./types.js";

const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "build",
  "edit",
  "yolo",
] as const satisfies readonly SwitchableCommandCenterMode[];

export function formatAvailableCommandCenterModes(): string {
  return SWITCHABLE_COMMAND_CENTER_MODES.join(", ");
}

export function isSwitchableCommandCenterMode(
  value: string,
): value is SwitchableCommandCenterMode {
  return SWITCHABLE_COMMAND_CENTER_MODES.includes(value as SwitchableCommandCenterMode);
}
