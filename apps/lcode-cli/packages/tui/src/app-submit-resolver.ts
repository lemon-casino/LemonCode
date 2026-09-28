import { selectedSlashCommand } from "./app-input.js";
import { modelOptionValue } from "./app-model-ref.js";
import type { SlashCommand, SlashSelectionState } from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

export function resolveComposerSubmittedText({
  effortOption,
  modeOption,
  modelOption,
  slashCommands,
  slashSelection,
  submittedValue,
}: {
  effortOption?: TuiEffortOption;
  modeOption?: TuiModeOption;
  modelOption?: TuiModelOption;
  slashCommands: readonly SlashCommand[];
  slashSelection?: SlashSelectionState;
  submittedValue: string;
}): string {
  const slashCommand = selectedSlashCommand(submittedValue, slashSelection, slashCommands);
  if (modelOption) return `/model ${modelOptionValue(modelOption)}`;
  if (effortOption) return `/effort ${effortOption.id}`;
  if (modeOption) return `/mode ${modeOption.id}`;
  if (slashCommand) return `/${slashCommand.name}`;
  return submittedValue;
}
